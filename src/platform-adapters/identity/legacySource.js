'use strict';

/**
 * legacySource.js — Identity Shadow (Phase 20.a, ADR-046/047/049).
 *
 * A thin, read-only view over the LEGACY, authoritative identity primitives (the certified
 * `src/middleware/auth.js` + admin/OTP config). It exposes the identity OPERATIONS the shadow
 * compares — evaluated by the exact production implementations — so parity is measured against the
 * real authority. This module performs NO identity logic of its own and NEVER mutates anything.
 *
 * Injected primitives (from the DI container / middleware/auth.js):
 *   { generateJWT, verifyJWT, adminPhones, requireOtp }
 * Pure operations (verify/issue-claims/isAdmin/otpRequired/resolvePrincipal) run anywhere. DB-bound
 * operations (refresh/revocation/repository) are declared but only exercised where a DB is present.
 */

function createLegacyIdentitySource(deps = {}) {
  const {
    generateJWT,
    verifyJWT,
    adminPhones = [],
    requireOtp = false,
    // DB-bound (optional; present only where a DB is wired)
    verifyRefreshToken,
    findUserByPhone,
    findDriverByPhone,
  } = deps;

  /** Decode a JWT body without verifying (for claim-shape comparison; drops signature). */
  function decodeClaims(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      return null;
    }
  }

  return Object.freeze({
    source: 'legacy:middleware/auth.js',

    /** Verify decision + decoded payload (the authoritative answer). */
    verify: (token) => (typeof verifyJWT === 'function' ? verifyJWT(token) : null),

    /** Issue a token then return its normalized claims (iat/exp dropped — time jitter). */
    issueClaims: (payload) => {
      if (typeof generateJWT !== 'function') return null;
      const claims = decodeClaims(generateJWT(payload));
      if (!claims) return null;
      // eslint-disable-next-line no-unused-vars
      const { iat, exp, ...stable } = claims;
      return stable;
    },

    /** Header (alg/typ) of an issued token — signature algorithm parity. */
    issueHeader: (payload) => {
      if (typeof generateJWT !== 'function') return null;
      const token = generateJWT(payload);
      try {
        return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      } catch {
        return null;
      }
    },

    /** Admin determination — legacy rule. */
    isAdmin: (payload) =>
      Boolean(payload && (payload.role === 'admin' || adminPhones.includes(payload.phone))),

    /** Whether OTP is required — legacy flag. */
    otpRequired: () => Boolean(requireOtp),

    // ── DB-bound operations (authoritative legacy answers) ──────────────────────
    /** Verify a refresh token → stored payload or null (legacy). */
    verifyRefresh: (rawToken) =>
      typeof verifyRefreshToken === 'function' ? verifyRefreshToken(rawToken) : null,
    /** Repository read: user by phone (legacy). */
    findUserByPhone: (phone) =>
      typeof findUserByPhone === 'function' ? findUserByPhone(phone) : undefined,
    /** Repository read: driver by phone (legacy). */
    findDriverByPhone: (phone) =>
      typeof findDriverByPhone === 'function' ? findDriverByPhone(phone) : undefined,

    /** Principal shape resolved from a verified JWT payload (legacy field mapping). */
    resolvePrincipal: (payload) =>
      payload
        ? {
            subject: payload.phone != null ? String(payload.phone) : null,
            type: payload.type || null,
            role: payload.role || null,
            driverId: payload.driverId != null ? payload.driverId : null,
          }
        : null,
  });
}

module.exports = { createLegacyIdentitySource };
