'use strict';

/**
 * ports.js — Consolidated Identity Kernel outbound ports (Phase 19.4 skeleton, ADR-049 §5/§6).
 *
 * Defines the outbound port CONTRACTS the kernel depends on and a fail-fast `assertPorts`. The
 * kernel (application layer) NEVER imports infrastructure directly (ADR-005 dependency rule);
 * concrete adapters (infrastructure/identity/*) are injected at composition time and must satisfy
 * these shapes. SKELETON: contracts only; no adapter is wired into production this phase.
 */

const { IdentityPortError } = require('../../../domain/identity/kernel/errors');

/**
 * Required outbound ports and the methods each must expose. This is the single source of truth for
 * the kernel's dependencies and mirrors the responsibilities ADR-049 assigns to infrastructure.
 */
const REQUIRED_PORTS = Object.freeze({
  // JWT + refresh + revocation (future owner of the middleware/auth.js primitives).
  tokenPort: [
    'issueAccessToken',
    'verifyAccessToken',
    'issueRefreshToken',
    'verifyRefreshToken',
    'revokeRefreshToken',
    'revokeAllRefreshTokens',
    'revokeAccessTokens',
  ],
  // OTP send/verify (future owner of services/otpService.js).
  otpPort: ['isRequired', 'send', 'verify'],
  // Identity persistence seam (reads Users/Drivers via their repos; owns login_logs write).
  identityRepositoryPort: [
    'findUserByPhone',
    'createUser',
    'findDriverByPhone',
    'createDriver',
    'setDriverPresence',
    'recordLoginLog',
  ],
  // Session + device identity persistence.
  sessionStorePort: ['persist', 'find', 'revoke'],
});

/** Optional ports (defaulted if absent). */
const OPTIONAL_PORTS = Object.freeze(['eventPublisher', 'metrics', 'logger', 'clock']);

/**
 * Verify all required ports are present and expose their required methods. Fail-fast at
 * composition (ADR-005 §2). Returns the ports object unchanged when valid.
 */
function assertPorts(ports = {}) {
  for (const [name, methods] of Object.entries(REQUIRED_PORTS)) {
    const p = ports[name];
    if (!p || typeof p !== 'object') {
      throw new IdentityPortError(`Identity Kernel: required port "${name}" is missing`);
    }
    for (const m of methods) {
      if (typeof p[m] !== 'function') {
        throw new IdentityPortError(`Identity Kernel: port "${name}" must implement "${m}()"`);
      }
    }
  }
  return ports;
}

module.exports = { REQUIRED_PORTS, OPTIONAL_PORTS, assertPorts };
