'use strict';

/**
 * Observability Platform — composition entry point (Phase 15.4 / ADR-033). Wires the
 * service with a provider + metrics and returns the Kernel Service as one factory.
 * Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the observability kernel is instantiated.
 *
 *   const ok = createObservabilityPlatform({ publisher });
 *   ok.observability.register({ componentId: 'trips', service: 'trips' });
 *   await ok.observability.collect({ componentId: 'trips', health: 'healthy', counters: { req: 1 } });
 *   const snap = await ok.observability.snapshot();
 */

const { createObservabilityService } = require('./observabilityService');
const { createObservabilityMetrics } = require('./metrics');
const providers = require('./providers');
const observabilityPort = require('./observabilityPort');
const providerPort = require('./providerPort');
const { OBSERVABILITY_EVENTS } = require('../../domain/observability/events');

function createObservabilityPlatform(deps = {}) {
  const metrics = deps.metrics || createObservabilityMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const observability = createObservabilityService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { observability, provider, metrics, OBSERVABILITY_EVENTS };
}

module.exports = {
  createObservabilityPlatform,
  createObservabilityService,
  createObservabilityMetrics,
  providers,
  observabilityPort,
  providerPort,
  OBSERVABILITY_EVENTS,
};
