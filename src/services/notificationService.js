'use strict';

/**
 * notificationService.js — FCM Push Notification Service (P6-02)
 *
 * يستخدم FCM HTTP v1 API عبر Node.js built-ins فقط (crypto + https) — لا حاجة لأي npm package.
 *
 * إعداد البيئة (env vars):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — محتوى service account JSON كاملاً (أو base64)
 *   FIREBASE_PROJECT_ID            — Firebase project ID (يُقرأ تلقائياً من service account)
 *
 * Graceful Degradation:
 *   إذا لم يُضبط FIREBASE_SERVICE_ACCOUNT_JSON:
 *     - send() و broadcast() يُعيدان { success: false, reason: 'not_configured' }
 *     - البرنامج يعمل بشكل طبيعي بدون push — فقط in-app Socket.IO
 *
 * استخدام:
 *   const { createNotificationService } = require('./services/notificationService');
 *   const notifService = createNotificationService({ dbAll, dbRun, logger });
 *   await notifService.send(phone, 'العنوان', 'النص', { tripId: '123' });
 *   await notifService.broadcast(['phone1', 'phone2'], 'عنوان', 'نص');
 */

const crypto = require('crypto');
const https = require('https');

// P6-05B / Phase 18.4: service account read via the runtime config facade (single config-read seam).
const config = require('../config');
const FIREBASE_SERVICE_ACCOUNT = config.get('FIREBASE_SERVICE_ACCOUNT');
const _DEFAULT_PROJECT_ID = config.get('FIREBASE_PROJECT_ID');

// ─── OAuth2 Token Cache ───────────────────────────────────────────────────────
// نخزّن الـ access token حتى 55 دقيقة (Google يُصدره لمدة 60 دق)
let _cachedAccessToken = null;
let _tokenExpiresAt = 0;

// ─── HTTPS helper ─────────────────────────────────────────────────────────────

function _httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ─── OAuth2: Service Account → Access Token ───────────────────────────────────

async function _getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  // أعِد استخدام الـ token إذا انتهت صلاحيته بعد أكثر من دقيقة
  if (_cachedAccessToken && _tokenExpiresAt > now + 60) return _cachedAccessToken;

  // بناء JWT assertion — HS256 ليست مقبولة هنا، نستخدم RS256 بالمفتاح الخاص لـ service account
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(serviceAccount.private_key, 'base64url');
  const jwtAssertion = `${header}.${payload}.${sig}`;

  const formBody = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwtAssertion}`;
  const res = await _httpsPost('oauth2.googleapis.com', '/token', formBody, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  if (res.status !== 200) {
    throw new Error(`OAuth2 token request failed: ${res.status} ${res.body}`);
  }

  const data = JSON.parse(res.body);
  _cachedAccessToken = data.access_token;
  _tokenExpiresAt = now + (data.expires_in || 3600);
  return _cachedAccessToken;
}

// ─── Send single FCM message ──────────────────────────────────────────────────

async function _sendOne(serviceAccount, projectId, deviceToken, title, body, data) {
  const accessToken = await _getAccessToken(serviceAccount);

  const message = {
    message: {
      token: deviceToken,
      notification: { title, body },
      // data values يجب أن تكون strings
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: { sound: 'default', channel_id: 'oncall_default' },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
      },
    },
  };

  const res = await _httpsPost(
    'fcm.googleapis.com',
    `/v1/projects/${projectId}/messages:send`,
    JSON.stringify(message),
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    }
  );

  const parsed = JSON.parse(res.body);

  // استخرج رمز الخطأ من استجابة FCM v1
  if (res.status !== 200 || parsed.error) {
    const details = parsed.error?.details || [];
    const errCode =
      details.find((d) => d.errorCode)?.errorCode || parsed.error?.message || 'UNKNOWN';
    const err = new Error(errCode);
    err.fcmStatus = res.status;
    err.fcmCode = errCode;
    throw err;
  }

  return parsed; // { name: "projects/xxx/messages/xxx" }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @param {{ dbAll: Function, dbRun: Function, logger: object }} svc
 * @returns {{ send: Function, broadcast: Function, isConfigured: boolean }}
 */
function createNotificationService({ dbAll, dbRun, logger }) {
  // P6-05B: use values already parsed and validated by env.js
  const serviceAccount = FIREBASE_SERVICE_ACCOUNT;
  const projectId = _DEFAULT_PROJECT_ID;
  const isConfigured = !!(serviceAccount && projectId);

  // P6-03: Stats tracking
  const _stats = {
    sent: 0,
    failed: 0,
    skipped: 0, // no_device_tokens or not_configured
    lastSentAt: null,
    broadcastCount: 0,
  };

  if (!isConfigured) {
    logger.warn(
      'P6-02: FCM غير مُضبط — أضِف FIREBASE_SERVICE_ACCOUNT_JSON لتفعيل Push Notifications'
    );
  } else {
    logger.info(`P6-02: FCM مُضبط — project: ${projectId}`);
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  async function _getDeviceTokens(phone) {
    return dbAll('SELECT device_token, platform FROM device_tokens WHERE phone = ?', [phone]);
  }

  function _isInvalidToken(fcmCode) {
    return ['UNREGISTERED', 'INVALID_ARGUMENT'].includes(fcmCode);
  }

  async function _cleanInvalidToken(deviceToken) {
    dbRun('DELETE FROM device_tokens WHERE device_token = ?', [deviceToken]).catch((e) =>
      logger.error('FCM: خطأ في حذف token منتهي:', { message: e.message })
    );
  }

  // ─── send(phone, title, body, data?) ─────────────────────────────────────────
  /**
   * يُرسل push notification لجميع أجهزة المستخدم المسجّلة.
   * @param {string} phone
   * @param {string} title
   * @param {string} body
   * @param {Object} [data={}] — بيانات إضافية (deep link, tripId, ...)
   * @returns {Promise<{ success: boolean, sent: number, failed: number, reason?: string }>}
   */
  async function send(phone, title, body, data = {}) {
    if (!isConfigured) {
      _stats.skipped++;
      return { success: false, reason: 'not_configured' };
    }

    const tokens = await _getDeviceTokens(phone);
    if (!tokens.length) {
      _stats.skipped++;
      return { success: false, reason: 'no_device_tokens' };
    }

    const results = await Promise.allSettled(
      tokens.map(({ device_token }) =>
        _sendOne(serviceAccount, projectId, device_token, title, body, data)
      )
    );

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        sent++;
      } else {
        failed++;
        const fcmCode = r.reason?.fcmCode || '';
        logger.warn(`FCM send failed [${phone}]: ${fcmCode || r.reason?.message}`);
        // احذف الـ tokens المنتهية أو الخاطئة تلقائياً
        if (_isInvalidToken(fcmCode)) {
          _cleanInvalidToken(tokens[i].device_token);
        }
      }
    }

    // P6-03: update stats
    _stats.sent += sent;
    _stats.failed += failed;
    if (sent > 0) _stats.lastSentAt = new Date().toISOString();

    logger.info(`FCM: ${phone} → sent=${sent} failed=${failed}`);
    return { success: sent > 0, sent, failed };
  }

  // ─── broadcast(phones[], title, body, data?) ─────────────────────────────────
  /**
   * يُرسل push notification لقائمة مستخدمين.
   * @param {string[]} phones
   * @param {string} title
   * @param {string} body
   * @param {Object} [data={}]
   * @returns {Promise<{ success: boolean, total: number, sent: number, failed: number }>}
   */
  async function broadcast(phones, title, body, data = {}) {
    if (!isConfigured) return { success: false, reason: 'not_configured', total: phones.length };
    if (!phones.length) return { success: true, total: 0, sent: 0, failed: 0 };

    const results = await Promise.allSettled(phones.map((phone) => send(phone, title, body, data)));

    const sent = results.filter((r) => r.status === 'fulfilled' && r.value?.success).length;
    const failed = phones.length - sent;

    // P6-03: update broadcast stats
    _stats.broadcastCount++;
    _stats.sent += sent;
    _stats.failed += failed;

    logger.info(`FCM broadcast: total=${phones.length} sent=${sent} failed=${failed}`);
    return { success: true, total: phones.length, sent, failed };
  }

  // P6-03: Stats accessor
  function getStats() {
    return {
      isConfigured,
      ..._stats,
    };
  }

  return { send, broadcast, isConfigured, getStats };
}

module.exports = { createNotificationService };
