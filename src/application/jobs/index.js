'use strict';

/**
 * Background Jobs Platform — composition entry point (Phase 15.3 / ADR-032). Wires
 * the service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the jobs kernel is instantiated.
 *
 *   const jk = createJobsPlatform({ publisher });
 *   jk.jobs.register({ type: 'send-email', handler: async (payload) => { ... } });
 *   await jk.jobs.enqueue({ type: 'send-email', payload: { to: 'a@b.c' } });
 *   await jk.jobs.tick(now); // execute due jobs
 */

const { createJobsService } = require('./jobsService');
const { createJobsMetrics } = require('./metrics');
const providers = require('./providers');
const jobsPort = require('./jobsPort');
const providerPort = require('./providerPort');
const { JOB_EVENTS } = require('../../domain/jobs/events');

function createJobsPlatform(deps = {}) {
  const metrics = deps.metrics || createJobsMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const jobs = createJobsService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { jobs, provider, metrics, JOB_EVENTS };
}

module.exports = {
  createJobsPlatform,
  createJobsService,
  createJobsMetrics,
  providers,
  jobsPort,
  providerPort,
  JOB_EVENTS,
};
