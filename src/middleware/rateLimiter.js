'use strict';

/**
 * rateLimiter.js — OnCall rate limiting middleware
 * In-memory rate limiting by IP (suitable for single-server deployment).
 * For multi-server: replace Map with Redis.
 */

const rateLimitMap = new Map(); // IP → [timestamps]
const phoneRateLimitMap = new Map(); // phone → { count, firstAt, lockedUntil }

// ─── IP-based rate limiter ────────────────────────────────────────────────────

/**
 * Factory that returns an Express middleware enforcing a sliding-window
 * rate limit per client IP.
 * @param {number} maxRequests  Maximum requests allowed in the window
 * @param {number} windowMs     Window size in milliseconds
 */
function rateLimit(maxRequests = 100, windowMs = 60000) {
  return (req, res, next) => {
    const key =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.ip ||
      'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
    const requests = rateLimitMap.get(key).filter((t) => t > windowStart);
    requests.push(now);
    rateLimitMap.set(key, requests);

    if (requests.length > maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'طلبات كثيرة - حاول بعد دقيقة',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    }
    next();
  };
}

// ─── Phone-based lock ─────────────────────────────────────────────────────────

/**
 * Factory that returns an Express middleware locking a phone number
 * after too many attempts within a window.
 * @param {number} maxAttempts  Max attempts before lock
 * @param {number} lockMs       Lock duration in milliseconds
 */
function phoneRateLimit(maxAttempts = 5, lockMs = 300000) {
  return (req, res, next) => {
    const phone = req.body?.phone;
    if (!phone) return next();

    const now = Date.now();
    const record = phoneRateLimitMap.get(phone) || { count: 0, firstAt: now, lockedUntil: 0 };

    if (record.lockedUntil > now) {
      const remaining = Math.ceil((record.lockedUntil - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `تم قفل الحساب مؤقتاً - انتظر ${remaining} ثانية`,
        retryAfter: remaining,
      });
    }

    if (now - record.firstAt > lockMs) {
      record.count = 0;
      record.firstAt = now;
    }

    record.count++;
    if (record.count > maxAttempts) {
      record.lockedUntil = now + lockMs;
      phoneRateLimitMap.set(phone, record);
      const lockSecs = Math.ceil(lockMs / 1000);
      return res.status(429).json({
        success: false,
        message: `محاولات كثيرة - تم قفل الحساب ${Math.round(lockSecs / 60)} دقائق`,
        retryAfter: lockSecs,
      });
    }

    phoneRateLimitMap.set(phone, record);
    next();
  };
}

// ─── Named instances ──────────────────────────────────────────────────────────

const strictLimit = rateLimit(10, 60000); // 10 req/min — حساسة
const normalLimit = rateLimit(300, 60000); // 300 req/min — عامة
const loginLimit = rateLimit(20, 300000); // 20 logins/5 min
// إصلاح M4: خُفِّضت من 100/1min (قيمة تطوير) إلى 5/5min (إنتاج)
const phoneLoginLimit = phoneRateLimit(5, 300000); // 5 محاولات لكل هاتف/5 دقائق

// ─── Periodic cleanup ─────────────────────────────────────────────────────────

// unref(): لا يمنع الـ process من الخروج عند إغلاق السيرفر
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [key, times] of rateLimitMap.entries()) {
    const filtered = times.filter((t) => t > cutoff);
    if (filtered.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, filtered);
  }
  const now = Date.now();
  for (const [phone, record] of phoneRateLimitMap.entries()) {
    if (record.lockedUntil < now && now - record.firstAt > 300000) {
      phoneRateLimitMap.delete(phone);
    }
  }
}, 60000).unref();

module.exports = {
  rateLimit,
  phoneRateLimit,
  strictLimit,
  normalLimit,
  loginLimit,
  phoneLoginLimit,
};
