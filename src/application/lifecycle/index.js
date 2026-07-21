'use strict';

/**
 * Lifecycle Management Platform — composition entry point (Phase 15.11 / ADR-040).
 * Wires the service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the lifecycle kernel is instantiated.
 *
 *   const lk = createLifecyclePlatform({ publisher });
 *   lk.lifecycle.register({ componentId: 'db', componentType: 'datastore', hooks: { start: async () => {} } });
 *   lk.lifecycle.register({ componentId: 'api', componentType: 'service', dependencies: ['db'] });
 *   await lk.lifecycle.start(); // starts db then api (dependency order)
 *   await lk.lifecycle.stop();  // stops api then db (reverse order)
 */

const { createLifecycleService } = require('./lifecycleService');
const { createLifecycleMetrics } = require('./metrics');
const providers = require('./providers');
const lifecyclePort = require('./lifecyclePort');
const providerPort = require('./providerPort');
const { LIFECYCLE_EVENTS } = require('../../domain/lifecycle/events');

function createLifecyclePlatform(deps = {}) {
  const metrics = deps.metrics || createLifecycleMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const lifecycle = createLifecycleService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { lifecycle, provider, metrics, LIFECYCLE_EVENTS };
}

module.exports = {
  createLifecyclePlatform,
  createLifecycleService,
  createLifecycleMetrics,
  providers,
  lifecyclePort,
  providerPort,
  LIFECYCLE_EVENTS,
};
