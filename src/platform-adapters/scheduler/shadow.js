'use strict';

/**
 * shadow.js — Phase 17.6 Scheduler Shadow Verifier.
 *
 * Thin configuration over the shared generic round-trip verifier (`createRoundTripShadow`):
 *
 *   Legacy Schedules → Scheduler Adapter → Scheduler Kernel (schedule placed, NEVER started/ticked)
 *   → Parity Verification → Shadow Metrics → RETURN LEGACY BEHAVIOR
 *
 * All G1.0 §1 guarantees and the ADR-020 non-ownership/non-execution property are inherited
 * from the shared verifier + the Scheduler Adapter (which never calls start()/tick()). The
 * legacy scheduler remains the sole owner of timing and the sole producer of work.
 */

const { createRoundTripShadow } = require('../_shadow');

function createSchedulerShadow(deps = {}) {
  const adapter = deps.adapter;
  const legacy = deps.legacy;
  if (!adapter || typeof adapter.record !== 'function') {
    throw new Error('schedulerShadow: a Scheduler Adapter is required');
  }
  if (!legacy || typeof legacy.list !== 'function') {
    throw new Error('schedulerShadow: a legacy scheduler source is required');
  }

  /** The comparable shape for one legacy schedule (what the kernel must reproduce). */
  const legacyView = (descriptor) => ({
    descriptor,
    kernel: {
      name: descriptor.id,
      owner: descriptor.owner,
      scheduleType: adapter.expectedScheduleType(descriptor.kind),
      status: 'scheduled', // placed but never started/ticked ⇒ proves non-execution
    },
  });

  const rt = createRoundTripShadow({
    name: 'scheduler-shadow',
    adapter,
    legacy,
    buildLegacyView: legacyView,
    itemKey: (d) => d.id,
    countLabel: 'schedules',
    enabled: deps.enabled,
    metrics: deps.metrics,
    logger: deps.logger,
  });

  return Object.freeze({
    name: 'scheduler-shadow',
    enabled: rt.enabled,
    legacyView,
    verify: rt.verify,
    stats: rt.stats,
    metrics: rt.metrics,
  });
}

module.exports = { createSchedulerShadow };
