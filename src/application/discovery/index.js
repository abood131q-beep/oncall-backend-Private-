'use strict';

/**
 * Service Discovery Platform — composition entry point (Phase 15.5 / ADR-034). Wires
 * the service with a provider + cache + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the discovery kernel is instantiated.
 *
 *   const dk = createDiscoveryPlatform({ publisher });
 *   await dk.discovery.register({ serviceName: 'trips', endpoint: 'http://10.0.0.1:8080', capabilities: ['book'] });
 *   const r = await dk.discovery.resolve({ serviceName: 'trips', key: 'user-1' });
 */

const { createDiscoveryService } = require('./discoveryService');
const { createDiscoveryMetrics } = require('./metrics');
const { createDiscoveryCache } = require('./cache');
const providers = require('./providers');
const discoveryPort = require('./discoveryPort');
const providerPort = require('./providerPort');
const { DISCOVERY_EVENTS } = require('../../domain/discovery/events');

function createDiscoveryPlatform(deps = {}) {
  const metrics = deps.metrics || createDiscoveryMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const cache = deps.cache || createDiscoveryCache({ maxNamespaces: deps.cacheMaxNamespaces });
  const discovery = createDiscoveryService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { discovery, provider, cache, metrics, DISCOVERY_EVENTS };
}

module.exports = {
  createDiscoveryPlatform,
  createDiscoveryService,
  createDiscoveryMetrics,
  createDiscoveryCache,
  providers,
  discoveryPort,
  providerPort,
  DISCOVERY_EVENTS,
};
