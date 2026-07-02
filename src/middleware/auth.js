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
const { JWT_SECRET, ADMIN_PHONES } = require('../config/env');

// ─── In-memory token revocation ───────────────────────────────────────────────
// phone → revokedAt (Unix timestamp). Tokens issued BEFORE revokedAt are invalid.
// Reset on server restart — acceptable for 24h token lifetime; use Redis for HA.
const REVOKED_TOKENS = new Map();

/** Revoke all tokens issued before now for a phone number */
function revokeTokens(phone) {
  REVOKED_TOKENS.set(phone, Math.floor(Date.now() / 1000));
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

/** Sign a payload and return a HS256 JWT valid for 24 hours */
function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
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
    return res.status(401).json({ success: false, message: 'غير مصرح' });
  }
  if (payload.role !== 'admin' && !ADMIN_PHONES.includes(payload.phone)) {
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
};
