'use strict';

/**
 * schedulerShadow.js — Phase 17.6 wiring helpers for the Scheduler Kernel shadow.
 *
 * Same pattern as jobsShadow.js and fully G1.0-compliant. Gated by two flags (default OFF);
 * with both OFF the enterprise boot is byte-identical to Phase 17.5. The kernel is NEVER
 * authoritative, NEVER owns a timer, and NEVER executes a schedule.
 *
 *   PLATFORM_SCHEDULER=1 → inject the Scheduler kernel port into the adapter
 *   SHADOW_SCHEDULER=1   → additionally run parity comparisons (needs PLATFORM_SCHEDULER=1)
 */

const { createLegacySchedulerSource, createSchedulerShadow } = require('../platform-adapters');

/** Resolve the two Phase-17.6 flags from env (or explicit opts overrides). */
function selectSchedulerFlags(env = process.env, opts = {}) {
  const platformScheduler =
    opts.platformScheduler != null
      ? Boolean(opts.platformScheduler)
      : env.PLATFORM_SCHEDULER === '1';
  const shadowScheduler =
    opts.shadowScheduler != null ? Boolean(opts.shadowScheduler) : env.SHADOW_SCHEDULER === '1';
  // SHADOW requires PLATFORM (can't compare against a kernel that isn't wired).
  return { platformScheduler, shadowScheduler: shadowScheduler && platformScheduler };
}

/**
 * Create the shadow verifier over the (already port-injected) Scheduler Adapter.
 * @returns {object|null} the shadow, or null when PLATFORM_SCHEDULER is off.
 */
function attachSchedulerShadow({ adapters, shadowScheduler, logger, legacyOptions } = {}) {
  if (!adapters || !adapters.scheduler.consumed()) return null;
  const legacy = createLegacySchedulerSource(legacyOptions || {});
  return createSchedulerShadow({
    adapter: adapters.scheduler,
    legacy,
    enabled: () => Boolean(shadowScheduler),
    logger,
  });
}

module.exports = { selectSchedulerFlags, attachSchedulerShadow };
