'use strict';

/**
 * Token gateway adapter — Infrastructure layer.
 * Implements the tokenGateway port by delegating to the existing, certified
 * token primitives (src/middleware/auth.js) received through the DI
 * container. NO cryptographic or session logic is reimplemented here —
 * Phase 1 wraps the proven implementation (auth-safety rule).
 */
function createTokenGatewayAdapter(deps) {
  const {
    generateJWT,
    verifyJWT,
    revokeTokens,
    generateRefreshToken,
    verifyRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
    dbRun,
    dbGet,
  } = deps;

  return {
    issueAccessToken: (payload) => generateJWT(payload),
    issueRefreshToken: (payload) => generateRefreshToken(payload, dbRun),
    verifyRefreshToken: (token) => verifyRefreshToken(token, dbGet),
    revokeRefreshToken: (token) => revokeRefreshToken(token, dbRun),
    revokeAllRefreshTokens: (phone) => revokeAllRefreshTokens(phone, dbRun),
    verifyAccessToken: (token) => verifyJWT(token),
    revokeAccessTokens: (phone) => revokeTokens(phone),
  };
}

module.exports = { createTokenGatewayAdapter };
