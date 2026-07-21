'use strict';

/**
 * shadow.js — Phase 17.5 Jobs Shadow Verifier (refactored in 17.6 onto the shared generic
 * round-trip verifier). Thin configuration over `createRoundTripShadow`:
 *
 *   Legacy Jobs → Jobs Adapter → Jobs Kernel (definition placed, NEVER executed) →
 *   Parity Verification → Shadow Metrics → RETURN LEGACY BEHAVIOR
 *
 * All G1.0 §1 guarantees and the ADR-032 non-execution property are inherited from the shared
 * verifier + the Jobs Adapter (which never ticks). Public API is unchanged.
 */

const { createRoundTripShadow } = require('../_shadow');

function createJobsShadow(deps = {}) {
  const adapter = deps.adapter;
  const legacy = deps.legacy;
  if (!adapter || typeof adapter.record !== 'function') {
    throw new Error('jobsShadow: a Jobs Adapter is required');
  }
  if (!legacy || typeof legacy.list !== 'function') {
    throw new Error('jobsShadow: a legacy jobs source is required');
  }

  /** The comparable shape for one legacy descriptor (what the kernel must reproduce). */
  const legacyView = (descriptor) => ({
    descriptor,
    kernel: { type: descriptor.id, status: adapter.expectedStatus(descriptor.kind) },
  });

  const rt = createRoundTripShadow({
    name: 'jobs-shadow',
    adapter,
    legacy,
    buildLegacyView: legacyView,
    itemKey: (d) => d.id,
    countLabel: 'jobs',
    enabled: deps.enabled,
    metrics: deps.metrics,
    logger: deps.logger,
  });

  return Object.freeze({
    name: 'jobs-shadow',
    enabled: rt.enabled,
    legacyView,
    verify: rt.verify,
    stats: rt.stats,
    metrics: rt.metrics,
  });
}

module.exports = { createJobsShadow };
