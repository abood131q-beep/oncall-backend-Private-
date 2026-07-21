'use strict';

/**
 * otpService.js — P6-04B/C/D: One-Time Password (OTP) phone verification
 *
 * Security:
 *  - OTP stored as SHA-256 hash — never plaintext
 *  - Constant-time comparison (timingSafeEqual) — prevents timing attacks
 *  - 5-minute expiry
 *  - Max 3 attempts per code before automatic invalidation
 *  - Single-use: deleted on successful verification
 *  - UPSERT: re-sending replaces old OTP (no accumulation)
 *
 * P6-04C: SMS delivery via smsService — provider-agnostic (Unifonic / Twilio / console).
 *         يرمي Error إذا فشل الإرسال — يُعيد الـ route handler 500 بدلاً من false success.
 *
 * P6-04D: Security event logging لكل حالة OTP — قابلة للتتبع من Dashboard/Security Logs.
 *         رقم الهاتف يُخزَّن بعد Masking فقط — لا يُكشَف كاملاً في أي سجل.
 *
 * Security events: OTP_SENT | OTP_VERIFIED | OTP_FAILED | OTP_EXPIRED | OTP_LOCKED
 *
 * Usage:
 *  await sendOTP(phone, dbRun, logger, { requestId, provider });
 *  const ok = await verifyOTP(phone, code, dbGet, dbRun, { logger, requestId, provider });
 */

const crypto = require('crypto');
const smsService = require('./smsService');
// Phase 18.3: read via the runtime config facade (single approved config-read seam).
const config = require('../config');

const OTP_EXPIRY_SECONDS = 5 * 60; // 5 دقائق
const OTP_MAX_ATTEMPTS = 3;
const OTP_LENGTH = 6; // أرقام

// ─── Privacy helper ───────────────────────────────────────────────────────────

/**
 * Phone masking — يكشف أول 3 أرقام فقط: 965XXXXXXX → 965*******
 * يُستخدم في جميع سجلات الأمان للحفاظ على خصوصية المستخدم.
 * @param {string} p
 * @returns {string}
 */
const maskPhone = (p) =>
  p && p.length >= 3 ? `${p.slice(0, 3)}${'*'.repeat(p.length - 3)}` : '***';

// ─── sendOTP ──────────────────────────────────────────────────────────────────

/**
 * ينشئ رمز OTP عشوائياً (6 أرقام)، يُخزّن hash-ه في قاعدة البيانات،
 * ثم يُرسله عبر SMS (smsService).
 *
 * يرمي Error إذا فشل إرسال SMS — المُستدعي مسؤول عن إعادة 500.
 * يُسجِّل OTP_SENT في Security Log بعد نجاح الإرسال.
 *
 * @param {string}   phone      - رقم هاتف المستخدم
 * @param {Function} dbRun      - Promise wrapper لـ db.run
 * @param {object}   logger     - OnCall logger
 * @param {object}   [ctx={}]   - Security context: { requestId, provider }
 * @returns {Promise<void>}
 */
async function sendOTP(phone, dbRun, logger, ctx = {}) {
  // crypto.randomInt آمن — يولّد رقماً في [0, 10^6)
  const code = String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_EXPIRY_SECONDS;

  // UPSERT: يُستبدل الكود القديم إن وُجد — لا تراكم للـ OTPs (record واحد per phone)
  await dbRun(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET
       code_hash  = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts   = 0`,
    [phone, codeHash, expiresAt]
  );

  // P6-04C: إرسال SMS عبر smsService (يرمي Error إذا فشل — error propagation صحيح)
  const message = `رمز التحقق الخاص بك في OnCall: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`;
  await smsService.send(phone, message, logger);

  // P6-04D: Security log — يُسجَّل بعد نجاح الإرسال فقط
  logger.security('OTP_SENT', {
    maskedPhone: maskPhone(phone),
    provider: ctx.provider || config.get('SMS_PROVIDER'),
    requestId: ctx.requestId,
    timestamp: new Date().toISOString(),
    expiresInSec: OTP_EXPIRY_SECONDS,
  });
}

// ─── verifyOTP ────────────────────────────────────────────────────────────────

/**
 * يتحقق من كود OTP المُدخَل مقابل الـ hash المخزَّن.
 * يُسجِّل حدث أمان لكل نتيجة (نجاح / فشل / منتهٍ / مقفول).
 *
 * @param {string}   phone      - رقم هاتف المستخدم
 * @param {string}   code       - الكود الذي أدخله المستخدم
 * @param {Function} dbGet      - Promise wrapper لـ db.get
 * @param {Function} dbRun      - Promise wrapper لـ db.run
 * @param {object}   [ctx={}]   - Security context: { logger, requestId, provider }
 * @returns {Promise<boolean>} true إذا كان الكود صحيحاً وغير منتهٍ
 */
async function verifyOTP(phone, code, dbGet, dbRun, ctx = {}) {
  const { logger, requestId, provider } = ctx;
  const maskedPhone = maskPhone(phone);

  // الحقول المشتركة لجميع Security Events
  const logCtx = {
    maskedPhone,
    provider: provider || config.get('SMS_PROVIDER'),
    requestId,
    timestamp: new Date().toISOString(),
  };

  if (!code || typeof code !== 'string') return false;

  const row = await dbGet('SELECT * FROM otp_codes WHERE phone = ?', [phone]);
  if (!row) return false;

  const now = Math.floor(Date.now() / 1000);

  // ── انتهت الصلاحية ──────────────────────────────────────────────────────────
  if (row.expires_at < now) {
    await dbRun('DELETE FROM otp_codes WHERE phone = ?', [phone]);
    if (logger?.security) logger.security('OTP_EXPIRED', logCtx);
    return false;
  }

  // ── تجاوز الحد الأقصى للمحاولات ───────────────────────────────────────────
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await dbRun('DELETE FROM otp_codes WHERE phone = ?', [phone]);
    if (logger?.security)
      logger.security('OTP_LOCKED', {
        ...logCtx,
        attempts: row.attempts,
        maxAttempts: OTP_MAX_ATTEMPTS,
      });
    return false;
  }

  // ── مقارنة ثابتة الزمن (Timing-safe) ──────────────────────────────────────
  const inputHash = crypto.createHash('sha256').update(String(code)).digest('hex');
  const storedBuf = Buffer.from(row.code_hash, 'hex');
  const inputBuf = Buffer.from(inputHash, 'hex');

  const isValid =
    storedBuf.length === inputBuf.length && crypto.timingSafeEqual(storedBuf, inputBuf);

  if (!isValid) {
    await dbRun('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', [phone]);
    if (logger?.security)
      logger.security('OTP_FAILED', {
        ...logCtx,
        attempt: row.attempts + 1,
        maxAttempts: OTP_MAX_ATTEMPTS,
      });
    return false;
  }

  // ── صحيح — احذف الكود (single-use) ────────────────────────────────────────
  await dbRun('DELETE FROM otp_codes WHERE phone = ?', [phone]);
  if (logger?.security) logger.security('OTP_VERIFIED', logCtx);
  if (logger?.info) logger.info(`[OTP] Verified for ${maskedPhone}`);
  return true;
}

module.exports = { sendOTP, verifyOTP };
