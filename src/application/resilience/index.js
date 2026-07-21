'use strict';

/**
 * Resilience Platform — composition entry point (Phase 15.7 / ADR-036). Wires the
 * service with a provider + metrics and returns the Kernel Service as one factory.
 * Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the resilience kernel is instantiated.
 *
 *   const rk = createResiliencePlatform({ publisher });
 *   await rk.resilience.registerPolicy({ name: 'trips', failureThreshold: 3, recoveryWindow: 5000,
 *     retryPolicy: { maxAttempts: 3 }, backoffPolicy: { baseMs: 100 }, timeout: 1000 });
 *   const r = await rk.resilience.execute({ policyId, fn: callTrips, fallback: cached });
 */

const { createResilienceService } = require('./resilienceService');
const { createResilienceMetrics } = require('./metrics');
const providers = require('./providers');
const resiliencePort = require('./resiliencePort');
const providerPort = require('./providerPort');
const { RESILIENCE_EVENTS } = require('../../domain/resilience/events');

function createResiliencePlatform(deps = {}) {
  const metrics = deps.metrics || createResilienceMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const resilience = createResilienceService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { resilience, provider, metrics, RESILIENCE_EVENTS };
}

module.exports = {
  createResiliencePlatform,
  createResilienceService,
  createResilienceMetrics,
  providers,
  resiliencePort,
  providerPort,
  RESILIENCE_EVENTS,
};
