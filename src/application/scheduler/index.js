'use strict';

/**
 * Scheduler Platform — composition entry point (Phase 14.3.3). Wires the engine
 * with metrics and returns the whole Kernel Service as one factory. Purely
 * additive: nothing here is imported by a hot path, so the platform runs
 * byte-identically whether or not the scheduler is instantiated.
 *
 *   const sched = createSchedulerPlatform({ concurrency: 8, publisher });
 *   const id = sched.scheduler.scheduleAfter({ name, owner, handler }, 1000);
 *   await sched.scheduler.tick(Date.now() + 1000); // or sched.scheduler.start()
 */

const { createScheduler } = require('./scheduler');
const { createSchedulerMetrics } = require('./metrics');
const schedulerPort = require('./schedulerPort');
const { SCHEDULER_EVENTS } = require('../../domain/scheduler/events');

function createSchedulerPlatform(deps = {}) {
  const concurrency = deps.concurrency || 4;
  const metrics = deps.metrics || createSchedulerMetrics({ concurrency });
  const scheduler = createScheduler({
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    concurrency,
    setIntervalImpl: deps.setIntervalImpl,
    clearIntervalImpl: deps.clearIntervalImpl,
  });

  return { scheduler, metrics, SCHEDULER_EVENTS };
}

module.exports = {
  createSchedulerPlatform,
  createScheduler,
  createSchedulerMetrics,
  schedulerPort,
};
