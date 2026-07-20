'use strict';

/**
 * smsService.js — Provider-agnostic SMS delivery
 *
 * يدعم ثلاثة providers مهيَّأة عبر SMS_PROVIDER:
 *
 *  console  (default) — يطبع الكود في السجل. مناسب للتطوير والاختبار.
 *  unifonic            — Unifonic REST API (الكويت / GCC).
 *                        المتغيرات: SMS_API_KEY (App SID), SMS_FROM (Sender ID).
 *  twilio              — Twilio REST API (دولي).
 *                        المتغيرات: SMS_ACCOUNT_SID, SMS_API_KEY (Auth Token), SMS_FROM (رقم Twilio).
 *
 * الاستخدام:
 *   const smsService = require('./smsService');
 *   await smsService.send(phone, 'رمز التحقق: 123456');
 *
 * السلوك عند الفشل:
 *   - يرمي Error صريح — المُستدعي (otpService) مسؤول عن التعامل معه.
 *   - في بيئة الإنتاج مع provider=console: يرمي Error لمنع الإطلاق غير المقصود.
 *   - في بيئة التطوير مع provider=console: يُسجَّل الكود فقط (OK للاختبار).
 *
 * لا مكتبات خارجية — يستخدم node:https فقط.
 */

const https = require('https');
const {
  SMS_PROVIDER,
  SMS_API_KEY,
  SMS_FROM,
  SMS_ACCOUNT_SID,
  IS_PRODUCTION,
} = require('../config/env');

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Minimal HTTPS POST helper — بديل عن axios/node-fetch.
 * @param {string} hostname
 * @param {string} path
 * @param {object} payload   - JSON body
 * @param {object} [headers] - HTTP headers إضافية
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpsPost(hostname, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SMS request timed out after 10s'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Minimal HTTPS POST with Basic Auth (Twilio).
 */
function httpsPostBasicAuth(hostname, path, formBody, accountSid, authToken) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        Authorization: `Basic ${credentials}`,
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SMS request timed out after 10s'));
    });

    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
}

// ─── Providers ────────────────────────────────────────────────────────────────

/**
 * Unifonic REST API
 * Docs: https://developer.unifonic.com/reference/sendsms
 */
async function sendViaUnifonic(phone, message) {
  if (!SMS_API_KEY) throw new Error('SMS_API_KEY (Unifonic App SID) is required');
  if (!SMS_FROM) throw new Error('SMS_FROM (Unifonic Sender ID) is required');

  const result = await httpsPost('api.unifonic.com', '/rest/Messages/Send', {
    AppSid: SMS_API_KEY,
    Recipient: phone,
    Body: message,
    SenderID: SMS_FROM,
  });

  if (result.statusCode !== 200) {
    throw new Error(`Unifonic error ${result.statusCode}: ${result.body.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new Error(`Unifonic non-JSON response: ${result.body.slice(0, 200)}`);
  }

  // Unifonic يُعيد Success: true عند النجاح
  if (!parsed.Success && !parsed.success) {
    throw new Error(
      `Unifonic rejected message: ${parsed.Message || parsed.message || result.body.slice(0, 200)}`
    );
  }
}

/**
 * Twilio REST API
 * Docs: https://www.twilio.com/docs/sms/api/message-resource
 */
async function sendViaTwilio(phone, message) {
  if (!SMS_ACCOUNT_SID) throw new Error('SMS_ACCOUNT_SID is required for Twilio');
  if (!SMS_API_KEY) throw new Error('SMS_API_KEY (Twilio Auth Token) is required');
  if (!SMS_FROM) throw new Error('SMS_FROM (Twilio phone number e.g. +1415...) is required');

  // Twilio uses form-encoded body
  const params = new URLSearchParams({ From: SMS_FROM, To: phone, Body: message });
  const formBody = params.toString();

  const result = await httpsPostBasicAuth(
    'api.twilio.com',
    `/2010-04-01/Accounts/${SMS_ACCOUNT_SID}/Messages.json`,
    formBody,
    SMS_ACCOUNT_SID,
    SMS_API_KEY
  );

  if (result.statusCode !== 200 && result.statusCode !== 201) {
    throw new Error(`Twilio error ${result.statusCode}: ${result.body.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new Error(`Twilio non-JSON response: ${result.body.slice(0, 200)}`);
  }

  // Twilio error responses have an error_code field
  if (parsed.error_code) {
    throw new Error(`Twilio rejected message (${parsed.error_code}): ${parsed.message || ''}`);
  }
}

/**
 * Console provider — dev/testing.
 * In production: رمي خطأ صريح لمنع الإطلاق غير المقصود بدون SMS حقيقي.
 */
function sendViaConsole(phone, message, logger) {
  if (IS_PRODUCTION) {
    throw new Error(
      'SMS_PROVIDER=console is not allowed in production. ' +
        'Set SMS_PROVIDER=unifonic or SMS_PROVIDER=twilio with proper credentials.'
    );
  }
  // Dev/staging: اطبع في السجل
  if (logger) {
    logger.info(`[OTP-DEV] SMS to ${phone.slice(0, 3)}***: ${message}`);
  } else {
    // eslint-disable-next-line no-console
    console.info(`[OTP-DEV] SMS to ${phone.slice(0, 3)}***: ${message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an SMS message to the given phone number.
 * Throws on failure — caller should handle and return 500.
 *
 * @param {string}  phone   - رقم الهاتف الدولي (e.g. +96512345678)
 * @param {string}  message - نص الرسالة
 * @param {object}  [logger] - OnCall logger (اختياري، للـ console provider)
 * @returns {Promise<void>}
 */
async function send(phone, message, logger) {
  const provider = (SMS_PROVIDER || 'console').toLowerCase().trim();

  switch (provider) {
    case 'unifonic':
      return sendViaUnifonic(phone, message);

    case 'twilio':
      return sendViaTwilio(phone, message);

    case 'console':
    default:
      return sendViaConsole(phone, message, logger);
  }
}

module.exports = { send };
