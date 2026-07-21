'use strict';

/**
 * jobsShadow.js — Phase 17.5 wiring helpers for the Jobs Kernel shadow.
 *
 * Same pattern as configShadow.js / observabilityShadow.js and fully G1.0-compliant. Gated by
 * two flags (default OFF); with both OFF the enterprise boot is byte-identical to Phase 17.4.
 * The kernel is NEVER authoritative and NEVER executes a job.
 *
 *   PLATFORM_JOBS=1 → inject the Jobs kernel port into the adapter
 *   SHADOW_JOBS=1   → additionally run parity comparisons (needs PLATFORM_JOBS=1)
 *
 * The Jobs kernel needs no boot-time seeding: the shadow places each legacy job DEFINITION
 * into the kernel at verify time (as scheduled/queued, never ticked).
 */

const { createLegacyJobsSource, createJobsShadow } = require('../platform-adapters');

/** Resolve the two Phase-17.5 flags from env (or explicit opts overrides). */
function selectJobsFlags(env = process.env, opts = {}) {
  const platformJobs =
    opts.platformJobs != null ? Boolean(opts.platformJobs) : env.PLATFORM_JOBS === '1';
  const shadowJobs = opts.shadowJobs != null ? Boolean(opts.shadowJobs) : env.SHADOW_JOBS === '1';
  // SHADOW requires PLATFORM (can't compare against a kernel that isn't wired).
  return { platformJobs, shadowJobs: shadowJobs && platformJobs };
}

/**
 * Create the shadow verifier over the (already port-injected) Jobs Adapter.
 * @returns {object|null} the shadow, or null when PLATFORM_JOBS is off.
 */
function attachJobsShadow({ adapters, shadowJobs, logger, legacyOptions } = {}) {
  if (!adapters || !adapters.jobs.consumed()) return null;
  const legacy = createLegacyJobsSource(legacyOptions || {});
  return createJobsShadow({
    adapter: adapters.jobs,
    legacy,
    enabled: () => Boolean(shadowJobs),
    logger,
  });
}

module.exports = { selectJobsFlags, attachJobsShadow };
