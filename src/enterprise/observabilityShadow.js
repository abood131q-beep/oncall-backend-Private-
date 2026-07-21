'use strict';

/**
 * observabilityShadow.js — Phase 17.4 wiring helpers for the Observability Kernel shadow.
 *
 * Same pattern as configShadow.js. Gated by two flags (default OFF); with both OFF the
 * enterprise boot is byte-identical to Phase 17.3. The kernel is NEVER authoritative — these
 * helpers only enable a read-only shadow comparison through the Observability Adapter.
 *
 *   PLATFORM_OBSERVABILITY=1 → inject the Observability kernel port into the adapter
 *   SHADOW_OBSERVABILITY=1   → additionally run parity comparisons (needs PLATFORM_OBSERVABILITY=1)
 *
 * Unlike configuration, the Observability kernel needs no boot-time seeding: it starts empty
 * and the shadow feeds it a copy of the legacy observation at verify time.
 */

const {
  createLegacyObservabilitySource,
  createObservabilityShadow,
} = require('../platform-adapters');

/** Resolve the two Phase-17.4 flags from env (or explicit opts overrides). */
function selectObservabilityFlags(env = process.env, opts = {}) {
  const platformObservability =
    opts.platformObservability != null
      ? Boolean(opts.platformObservability)
      : env.PLATFORM_OBSERVABILITY === '1';
  const shadowObservability =
    opts.shadowObservability != null
      ? Boolean(opts.shadowObservability)
      : env.SHADOW_OBSERVABILITY === '1';
  // SHADOW requires PLATFORM (can't compare against a kernel that isn't wired).
  return {
    platformObservability,
    shadowObservability: shadowObservability && platformObservability,
  };
}

/**
 * Create the shadow verifier over the (already port-injected) Observability Adapter.
 * @returns {object|null} the shadow, or null when PLATFORM_OBSERVABILITY is off.
 */
function attachObservabilityShadow({ adapters, shadowObservability, logger, legacyOptions } = {}) {
  if (!adapters || !adapters.observability.consumed()) return null;
  const legacy = createLegacyObservabilitySource(legacyOptions || {});
  return createObservabilityShadow({
    adapter: adapters.observability,
    legacy,
    enabled: () => Boolean(shadowObservability),
    logger,
  });
}

module.exports = { selectObservabilityFlags, attachObservabilityShadow };
