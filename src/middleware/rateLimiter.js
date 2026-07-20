'use strict';

/**
 * rateLimiter.js — OnCall rate limiting middleware
 * In-memory rate limiting by IP (suitable for single-server deployment).
 * For multi-server: replace Map with Redis.
 *
 * P6-05B: Phone locks are persisted to SQLite (rate_limit_locks table) so they
 * survive server restarts. IP sliding-window timestamps are transient and NOT
 * persisted (they expire within the window anyway).
 */

// P6-03: Security logging for rate limit events
const logger = require('../utils/logger');

// P6-06 FIX: كل instance من rateLimit() له Map خاص به — يمنع تداخل الـ windows
// الخطأ السابق: Map واحدة مشتركة → كل طلب لـ /driver/login كان يُضاف مرتين
// (مرة من normalLimit ومرة من loginLimit) → فعلياً loginLimit=30 بدل 60
const allRateLimitMaps = []; // registry لكل الـ per-instance Maps (للـ cleanup)
const phoneRateLimitMap = new Map(); // phone → { count, firstAt, lockedUntil }

// DB functions injected at startup via initRateLimitStore()
let _dbRun = null;

/**
 * P6-05B: Called once after DB is ready to load persisted phone locks.
 * @param {Function} dbRun
 * @param {Function} dbAll
 */
async function initRateLimitStore(dbRun, dbAll) {
  _dbRun = dbRun;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = await dbAll(
      'SELECT phone, locked_until FROM rate_limit_locks WHERE locked_until > ?',
      [now]
    );
    for (const row of rows) {
      const record = phoneRateLimitMap.get(row.phone) || { count: 0, firstAt: Date.now() };
      record.lockedUntil = row.locked_until * 1000; // DB: Unix seconds → Map: ms
      phoneRateLimitMap.set(row.phone, record);
    }
    if (rows.length > 0) {
      logger.info(`[RateLimit] Loaded ${rows.length} active phone lock(s) from DB`);
    }
  } catch {
    // Table may not exist yet on first boot — migrate.js handles creation
  }
}

// ─── IP-based rate limiter ────────────────────────────────────────────────────

/**
 * Factory that returns an Express middleware enforcing a sliding-window
 * rate limit per client IP.
 * @param {number} maxRequests  Maximum requests allowed in the window
 * @param {number} windowMs     Window size in milliseconds
 */
function rateLimit(maxRequests = 100, windowMs = 60000) {
  // كل instance له Map مستقل — لا تداخل مع normalLimit أو أي limiter آخر
  const map = new Map();
  allRateLimitMaps.push({ map, windowMs });

  return (req, res, next) => {
    const key =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.ip ||
      'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!map.has(key)) map.set(key, []);
    const requests = map.get(key).filter((t) => t > windowStart);
    requests.push(now);
    map.set(key, requests);

    if (requests.length > maxRequests) {
      // P6-03: Log rate limit hit as security event
      logger.security('RATE_LIMIT_IP', {
        ip: key,
        path: req.path,
        method: req.method,
        requestId: req.id,
        count: requests.length,
        maxAllowed: maxRequests,
      });
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
      // P6-03: Log phone lock as security event
      logger.security('RATE_LIMIT_PHONE_LOCKED', {
        phone,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        path: req.path,
        requestId: req.id,
        remainingSec: remaining,
      });
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
      // P6-05B: persist lock to SQLite (fire-and-forget — Map already updated)
      if (_dbRun) {
        _dbRun(
          `INSERT INTO rate_limit_locks (phone, locked_until) VALUES (?, ?)
           ON CONFLICT(phone) DO UPDATE SET locked_until = excluded.locked_until`,
          [phone, Math.floor(record.lockedUntil / 1000)]
        ).catch(() => {});
      }
      const lockSecs = Math.ceil(lockMs / 1000);
      // P6-03: Log phone number lock trigger
      logger.security('RATE_LIMIT_PHONE_LOCKED_NEW', {
        phone,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        path: req.path,
        requestId: req.id,
        attempts: record.count,
        lockSecs,
      });
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

const strictLimit = rateLimit(10, 60000); // 10 req/min — حساسة (OTP, admin actions)
const normalLimit = rateLimit(600, 60000); // 600 req/min — عامة (10 req/sec/IP)
// P6-06 FIX: رُفع من 60→120 لأن السيناريوهات الإنتاجية (stress tests, batch admin ops)
// تحتاج: 1 admin login + 100 driver logins = 101 < 120
// لا يزال واقياً من brute-force: 120 محاولة/5 دقائق = 24 محاولة/دقيقة
const loginLimit = rateLimit(120, 300000); // 120 logins/5 min per IP
// المستخدم قد يتنقل بين passenger/driver ويعيد الاتصال — 15 محاولة/5 دقائق معقولة
const phoneLoginLimit = phoneRateLimit(15, 300000); // 15 محاولات لكل هاتف/5 دقائق

// ─── Periodic cleanup ─────────────────────────────────────────────────────────

// unref(): لا يمنع الـ process من الخروج عند إغلاق السيرفر
setInterval(() => {
  // نظّف كل الـ per-instance Maps المسجَّلة في allRateLimitMaps
  const globalCutoff = Date.now() - 300000; // أقصى window مستخدم
  for (const { map } of allRateLimitMaps) {
    for (const [key, times] of map.entries()) {
      const filtered = times.filter((t) => t > globalCutoff);
      if (filtered.length === 0) map.delete(key);
      else map.set(key, filtered);
    }
  }
  const now = Date.now();
  for (const [phone, record] of phoneRateLimitMap.entries()) {
    if (record.lockedUntil < now && now - record.firstAt > 300000) {
      phoneRateLimitMap.delete(phone);
    }
  }
  // P6-05B: حذف الأقفال المنتهية من SQLite
  if (_dbRun) {
    _dbRun('DELETE FROM rate_limit_locks WHERE locked_until <= ?', [
      Math.floor(Date.now() / 1000),
    ]).catch(() => {});
  }
}, 60000).unref();

module.exports = {
  rateLimit,
  phoneRateLimit,
  strictLimit,
  normalLimit,
  loginLimit,
  phoneLoginLimit,
  initRateLimitStore, // P6-05B
};
