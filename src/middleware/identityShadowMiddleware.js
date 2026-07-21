'use strict';

/**
 * identityShadowMiddleware.js — Phase 20.b (ADR-046/047/049).
 *
 * Integrates the Identity Shadow into the REAL HTTP request path as an OBSERVER. It runs the
 * shadow's parity comparisons (legacy vs consolidated kernel) for every request, records metrics,
 * and **returns nothing to the request** — it never reads/writes `req.user`, never touches the
 * response, and never throws. Legacy identity remains authoritative.
 *
 * Mounted ONLY when `PLATFORM_IDENTITY=1 && SHADOW_IDENTITY=1` (see onCallApplication.js). With the
 * flags OFF (default) this module is never required and never mounted ⇒ byte-identical production.
 */

/**
 * Build the identity shadow from the DI container + config, and an Express middleware that observes
 * each request. Also exposes the shadow (for socket reuse + parity reporting).
 * @param {object} services the DI container (has generateJWT/verifyJWT via middleware/auth, logger)
 * @returns {Function} express middleware with `.shadow` attached, or a no-op if it can't compose.
 */
function createIdentityShadowMiddleware(services = {}) {
  let shadow = null;
  try {
    // eslint-disable-next-line global-require
    const auth = require('./auth');
    // eslint-disable-next-line global-require
    const config = require('../config');
    // eslint-disable-next-line global-require
    const { attachIdentityShadow } = require('../enterprise/identityShadow');
    const primitives = {
      generateJWT: services.generateJWT || auth.generateJWT,
      verifyJWT: services.verifyJWT || auth.verifyJWT,
      generateRefreshToken: services.generateRefreshToken || auth.generateRefreshToken,
      verifyRefreshToken: services.verifyRefreshToken || auth.verifyRefreshToken,
      revokeRefreshToken: services.revokeRefreshToken || auth.revokeRefreshToken,
      revokeAllRefreshTokens: services.revokeAllRefreshTokens || auth.revokeAllRefreshTokens,
      revokeTokens: services.revokeTokens || auth.revokeTokens,
      adminPhones: services.ADMIN_PHONES || config.get('ADMIN_PHONES') || [],
      requireOtp: config.get('REQUIRE_OTP'),
    };
    shadow = attachIdentityShadow({
      platformIdentity: true,
      shadowIdentity: true,
      primitives,
      logger: services.logger,
    });
  } catch {
    shadow = null; // composition failure ⇒ no-op middleware (never affects requests)
  }

  const middleware = function identityShadowObserver(req, _res, next) {
    if (shadow) {
      try {
        const requestId = req.id || null;
        // Every request generates at least one comparison (otp requirement).
        shadow.shadowOtpRequired({ requestId });
        const token =
          (req.headers && req.headers['authorization']
            ? String(req.headers['authorization']).replace('Bearer ', '')
            : null) ||
          (req.headers && req.headers['x-session-token']) ||
          null;
        if (token) {
          const payload = shadow.shadowVerify(token, { requestId }); // returns LEGACY payload
          if (payload) {
            shadow.shadowResolvePrincipal(payload, { requestId });
            shadow.shadowIsAdmin(payload, { requestId });
          }
        }
      } catch {
        /* the shadow must NEVER influence the request */
      }
    }
    next();
  };
  middleware.shadow = shadow;
  return middleware;
}

/**
 * Mount the identity shadow observer early in the pipeline (before routes) and expose the shadow on
 * the DI container for socket reuse. No-op-safe.
 */
function mountIdentityShadow(app, services = {}) {
  const mw = createIdentityShadowMiddleware(services);
  if (mw.shadow) {
    services.identityShadow = mw.shadow; // socket handshake reuses the SAME shadow
    app.use(mw);
    (services.logger && services.logger.info ? services.logger.info : () => {})(
      'Identity shadow observer mounted (SHADOW_IDENTITY=1) — observational only, legacy authoritative'
    );
  }
  return mw.shadow;
}

module.exports = { createIdentityShadowMiddleware, mountIdentityShadow };
