'use strict';

/**
 * configShadow.js — Phase 17.3 wiring helpers for the Configuration Kernel shadow.
 *
 * Keeps the flag logic and seed/attach mechanics out of bootEnterprise. Everything here is
 * gated by two flags (default OFF); with both OFF the enterprise boot is byte-identical to
 * Phase 17.2. The kernel is NEVER authoritative — these helpers only enable a read-only
 * shadow comparison through the Configuration Adapter.
 *
 *   PLATFORM_CONFIG=1  → compose + seed the Config kernel and inject its port into the adapter
 *   SHADOW_CONFIG=1    → additionally run parity comparisons (needs PLATFORM_CONFIG=1)
 */

const { createLegacyConfigSource, createConfigShadow } = require('../platform-adapters');

/** Resolve the two Phase-17.3 flags from env (or explicit opts overrides). */
function selectConfigFlags(env = process.env, opts = {}) {
  const platformConfig =
    opts.platformConfig != null ? Boolean(opts.platformConfig) : env.PLATFORM_CONFIG === '1';
  const shadowConfig =
    opts.shadowConfig != null ? Boolean(opts.shadowConfig) : env.SHADOW_CONFIG === '1';
  // SHADOW_CONFIG requires PLATFORM_CONFIG (can't compare against a kernel that isn't wired).
  return { platformConfig, shadowConfig: shadowConfig && platformConfig };
}

/**
 * Build the legacy source + the kernel seed. Seeding the kernel with the SAME typed values
 * env.js computed is what lets parity reach 100% without re-implementing env.js. The seed is
 * DEEP-CLONED so the kernel's deep-freeze can never mutate the legacy config objects.
 *
 * @returns {{ legacy, kernelOptions }}
 */
function buildConfigSeed({ envExports } = {}) {
  const legacy = createLegacyConfigSource({ exports: envExports });
  const seed = structuredClone(legacy.snapshot());
  const kernelOptions = { config: { defaults: seed } };
  return { legacy, kernelOptions };
}

/**
 * Create the shadow verifier over the (already port-injected) Configuration Adapter.
 * @returns {object|null} the shadow, or null when PLATFORM_CONFIG is off.
 */
function attachConfigShadow({ adapters, legacy, shadowConfig, logger } = {}) {
  if (!legacy || !adapters || !adapters.configuration.consumed()) return null;
  return createConfigShadow({
    adapter: adapters.configuration,
    legacy,
    enabled: () => Boolean(shadowConfig),
    logger,
  });
}

module.exports = { selectConfigFlags, buildConfigSeed, attachConfigShadow };
