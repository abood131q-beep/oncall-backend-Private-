'use strict';

/**
 * Rate Limit Adapter — translates the application's rate-limit checks (normal/login/phone
 * limits, rate_limit_locks, per-socket driver:location limiter) into a Rate Limiting kernel
 * (ADR-031) request. INERT in Phase 17.2: limiting continues in the existing middleware and
 * socket handler, unchanged.
 */

const { requirePort } = require('../_base');

function createRateLimitAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'ratelimit',
    kernel: 'ratelimit (ADR-031)',
    consumed: () => port != null,
    // pure translation: app limit check → kernel request
    toRequest: ({ key, bucket, cost = 1 } = {}) => ({
      key: key != null ? String(key) : null,
      bucket: bucket || 'default',
      cost: Number(cost),
    }),
    // active (requires an injected Rate Limit kernel port) — NOT used in Phase 17.2
    check: (request) => requirePort('ratelimit', port).check(request),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createRateLimitAdapter };
