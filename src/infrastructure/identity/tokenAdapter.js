'use strict';

/**
 * tokenAdapter.js — Consolidated Identity Kernel infrastructure (Phase 20.a, ADR-049 §5).
 *
 * Future owner of the JWT + refresh + revocation primitives currently in `src/middleware/auth.js`.
 * Implements the kernel's `tokenPort` contract.
 *
 * SHADOW-PHASE POSTURE: this is a **thin pass-through** — when the certified legacy primitives are
 * injected via `deps`, each method delegates to the EXACT SAME function `middleware/auth.js`
 * provides, so the kernel path produces byte-identical results (the Identity shadow proves it). NO
 * crypto/SQL is reimplemented or moved. When a primitive is NOT injected, the method throws
 * `IdentityKernelNotWired` (safe default — 19.4 inert behavior preserved). Legacy remains
 * authoritative; nothing here is on the production request path.
 */

const { IdentityKernelNotWired } = require('../../domain/identity/kernel/errors');

function createIdentityTokenAdapter(deps = {}) {
  // Delegate to the injected legacy primitive, or stay inert (NotWired) if absent.
  const passthrough = (fn, name) =>
    typeof fn === 'function'
      ? fn
      : () => {
          throw new IdentityKernelNotWired(`tokenAdapter.${name}`);
        };

  return Object.freeze({
    issueAccessToken: passthrough(deps.generateJWT, 'issueAccessToken'),
    verifyAccessToken: passthrough(deps.verifyJWT, 'verifyAccessToken'),
    issueRefreshToken: passthrough(deps.generateRefreshToken, 'issueRefreshToken'),
    verifyRefreshToken: passthrough(deps.verifyRefreshToken, 'verifyRefreshToken'),
    revokeRefreshToken: passthrough(deps.revokeRefreshToken, 'revokeRefreshToken'),
    revokeAllRefreshTokens: passthrough(deps.revokeAllRefreshTokens, 'revokeAllRefreshTokens'),
    revokeAccessTokens: passthrough(deps.revokeTokens, 'revokeAccessTokens'),
  });
}

module.exports = { createIdentityTokenAdapter };
