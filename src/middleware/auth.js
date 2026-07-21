'use strict';

/**
 * auth.js — OnCall authentication middleware
 * Provides JWT generation/verification and Express middleware for
 * protecting routes that require user or admin authentication.
 *
 * Security notes:
 *  - verifyJWT uses crypto.timingSafeEqual to prevent timing attacks (C2 fix)
 *  - authenticate reads token from headers only — query string rejected (H1 fix)
 *  - Token revocation: update REVOKED_TOKENS map and bump TOKEN_VERSION per-user
 */

const crypto = require('crypto');
// Phase 18.4: config read via the runtime facade (single approved config-read seam).
const config = require('../config');
const JWT_SECRET = config.get('JWT_SECRET');
const ADMIN_PHONES = config.get('ADMIN_PHONES');
// P6-03: Security logging
const logger = require('../utils/logger');

// ─── Token expiry constants ───────────────────────────────────────────────────
const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 دقيقة — للراكب / السائق
const ADMIN_TOKEN_EXPIRY = 24 * 60 * 60; // 24 ساعة  — للمشرف / MCP
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 يوم   — جميع المستخدمين

// ─── Token revocation (in-memory + SQLite persistence) ────────────────────────
// phone → revokedAt (Unix timestamp). Tokens issued AT OR BEFORE revokedAt are invalid.
// In-memory Map is the fast path; SQLite persists revocations across server restarts.
const REVOKED_TOKENS = new Map();

// DB functions injected at startup via initRevocationStore()
let _dbRun = null;
let _dbAll = null;

/**
 * Called once at server startup (after DB is ready) to:
 * 1. Load existing revocations from SQLite into the in-memory Map.
 * 2. Store DB references for future writes.
 * @param {Function} dbRun
 * @param {Function} dbAll
 */
async function initRevocationStore(dbRun, dbAll) {
  _dbRun = dbRun;
  _dbAll = dbAll;
  try {
    const rows = await dbAll('SELECT phone, revoked_at FROM revoked_tokens', []);
    for (const row of rows) {
      REVOKED_TOKENS.set(row.phone, row.revoked_at);
    }
  } catch {
    // Table may not exist yet during first boot — migrate.js handles creation
  }
}

// Phase 12 (C2): optional cross-instance revocation propagation. Default-off; a
// no-op unless REDIS_URL is configured. DB remains the durable source of truth;
// this only closes the multi-replica staleness window (a revoked token would
// otherwise stay valid on other replicas until their next boot-time reload).
let _publishRevocation = null;
/** Register a publisher used to broadcast revocations to other replicas. */
function setRevocationPublisher(fn) {
  _publishRevocation = typeof fn === 'function' ? fn : null;
}
/** Apply a revocation received FROM another replica (updates the local cache only). */
function applyRemoteRevocation(phone, ts) {
  const cur = REVOKED_TOKENS.get(phone);
  if (!cur || ts > cur) REVOKED_TOKENS.set(phone, ts);
}

/** Revoke all access tokens issued before now for a phone number (Map + DB [+ Redis]) */
function revokeTokens(phone) {
  const ts = Math.floor(Date.now() / 1000);
  REVOKED_TOKENS.set(phone, ts);
  if (_dbRun) {
    _dbRun(
      'INSERT INTO revoked_tokens (phone, revoked_at) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET revoked_at = excluded.revoked_at',
      [phone, ts]
    ).catch(() => {}); // fire-and-forget — Map already updated
  }
  if (_publishRevocation) {
    try {
      _publishRevocation(phone, ts);
    } catch {
      /* best-effort cross-instance fan-out */
    }
  }
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

/**
 * Sign a payload and return a HS256 JWT.
 * Admin tokens live 24h; passenger/driver access tokens live 15 min.
 */
function generateJWT(payload) {
  const expirySeconds = payload.role === 'admin' ? ADMIN_TOKEN_EXPIRY : ACCESS_TOKEN_EXPIRY;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expirySeconds,
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

// ─── Refresh Token ────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random refresh token, store its SHA-256 hash
 * in the database, and return the raw token (sent to the client once).
 *
 * @param {{ phone, type, role, driverId?, name? }} payload
 * @param {Function} dbRun — Promise wrapper for db.run
 * @returns {Promise<string>} raw refresh token (64 URL-safe chars)
 */
async function generateRefreshToken(payload, dbRun) {
  const rawToken = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY;

  await dbRun(
    `INSERT INTO refresh_tokens (phone, token_hash, type, role, driver_id, name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.phone,
      tokenHash,
      payload.type,
      payload.role || payload.type,
      payload.driverId || null,
      payload.name || null,
      expiresAt,
    ]
  );
  return rawToken;
}

/**
 * Verify a raw refresh token.
 * Returns the stored payload or null if invalid/expired/revoked.
 *
 * @param {string} rawToken
 * @param {Function} dbGet — Promise wrapper for db.get
 * @returns {Promise<object|null>}
 */
async function verifyRefreshToken(rawToken, dbGet) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  try {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const row = await dbGet(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = ? AND revoked = 0 AND expires_at > ?`,
      [tokenHash, Math.floor(Date.now() / 1000)]
    );
    if (!row) return null;
    return {
      phone: row.phone,
      type: row.type,
      role: row.role,
      driverId: row.driver_id,
      name: row.name,
    };
  } catch {
    return null;
  }
}

/**
 * Mark a single refresh token as revoked (used after rotation).
 *
 * @param {string} rawToken
 * @param {Function} dbRun
 */
async function revokeRefreshToken(rawToken, dbRun) {
  if (!rawToken || typeof rawToken !== 'string') return;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await dbRun(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`, [tokenHash]);
}

/**
 * Revoke ALL active refresh tokens for a phone number.
 * Used by POST /auth/logout-all.
 *
 * @param {string} phone
 * @param {Function} dbRun
 */
async function revokeAllRefreshTokens(phone, dbRun) {
  await dbRun(`UPDATE refresh_tokens SET revoked = 1 WHERE phone = ?`, [phone]);
}

/** Verify a JWT string; returns the payload or null on failure */
function verifyJWT(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;

    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');

    // Constant-time comparison — prevents timing attacks that could forge signatures
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Check token revocation: reject tokens issued at or before the revocation timestamp.
    // Uses <= not < because login and logout can share the same Unix second.
    const revokedAt = REVOKED_TOKENS.get(payload.phone);
    if (revokedAt && payload.iat <= revokedAt) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/** Require a valid user JWT (passenger or driver) */
function authenticate(req, res, next) {
  // Accept token only from headers — never from query string (prevents token leakage in logs)
  const token =
    req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) {
    // P6-03: Log JWT failure as security event
    logger.security('JWT_FAILURE', {
      ip: req.ip,
      path: req.path,
      method: req.method,
      requestId: req.id,
      hasToken: !!token,
    });
    return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
  }
  req.user = payload;
  next();
}

/** Require a valid driver JWT — rejects passengers and unauthenticated requests */
function authenticateDriver(req, res, next) {
  const token =
    req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
  }
  if (payload.type !== 'driver') {
    return res.status(403).json({ success: false, message: 'هذا الإجراء مخصص للسائقين فقط' });
  }
  req.user = payload;
  next();
}

/** Require a valid passenger JWT — rejects drivers and unauthenticated requests */
function authenticatePassenger(req, res, next) {
  const token =
    req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
  }
  if (payload.type !== 'passenger') {
    return res.status(403).json({ success: false, message: 'هذا الإجراء مخصص للركاب فقط' });
  }
  req.user = payload;
  next();
}

/** Require admin role or phone listed in ADMIN_PHONES */
function authenticateAdmin(req, res, next) {
  const token =
    req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) {
    // P6-03: Log admin JWT failure as security event
    logger.security('JWT_FAILURE_ADMIN', {
      ip: req.ip,
      path: req.path,
      method: req.method,
      requestId: req.id,
      hasToken: !!token,
    });
    return res.status(401).json({ success: false, message: 'غير مصرح' });
  }
  if (payload.role !== 'admin' && !ADMIN_PHONES.includes(payload.phone)) {
    // P6-03: Log unauthorized admin access attempt
    logger.security('UNAUTHORIZED_ADMIN', {
      ip: req.ip,
      phone: payload.phone,
      path: req.path,
      method: req.method,
      requestId: req.id,
    });
    return res.status(403).json({ success: false, message: 'صلاحيات المشرف مطلوبة' });
  }
  req.user = payload;
  next();
}

// ─── Legacy compatibility wrappers ───────────────────────────────────────────

const createSession = (phone, type, name) => generateJWT({ phone, type, name, role: type });
const getSession = (token) => verifyJWT(token);
const requireAuth = authenticate;

module.exports = {
  initRevocationStore,
  setRevocationPublisher,
  applyRemoteRevocation,
  generateJWT,
  verifyJWT,
  authenticate,
  authenticateDriver,
  authenticatePassenger,
  authenticateAdmin,
  createSession,
  getSession,
  requireAuth,
  revokeTokens,
  // P6-01 — Refresh Token
  generateRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
};
