'use strict';

/**
 * Identity Adapter — translates between the application's JWT payload shape and the
 * Identity kernel (ADR-027) principal/session shape. INERT in Phase 17.2: authentication
 * is UNCHANGED — src/middleware/auth.js remains the sole source of truth for token issue
 * and verify. This adapter only defines the mapping for a future phase.
 */

const { requirePort } = require('../_base');

function createIdentityAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'identity',
    kernel: 'identity (ADR-027)',
    consumed: () => port != null,
    // pure translation: JWT payload → principal (shape-only; no verification here)
    toPrincipal: (payload = {}) => ({
      subject: payload.phone != null ? String(payload.phone) : null,
      kind: payload.type || null,
      attributes: { driverId: payload.driverId ?? null },
    }),
    // active (requires an injected Identity kernel port) — NOT used in Phase 17.2
    verify: (token) => requirePort('identity', port).verify(token),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

const { createLegacyIdentitySource } = require('./legacySource');
const { createKernelIdentitySource } = require('./kernelSource');
const { createIdentityShadow, CATEGORIES } = require('./shadow');

module.exports = {
  createIdentityAdapter,
  // Phase 20.a — Identity shadow building blocks (legacy authoritative; kernel non-authoritative)
  createLegacyIdentitySource,
  createKernelIdentitySource,
  createIdentityShadow,
  IDENTITY_SHADOW_CATEGORIES: CATEGORIES,
};
