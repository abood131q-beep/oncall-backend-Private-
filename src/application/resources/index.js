'use strict';

/**
 * Resource Management Platform — composition entry point (Phase 15.10 / ADR-039).
 * Wires the service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the resource kernel is instantiated.
 *
 *   const rk = createResourcePlatform({ publisher });
 *   const r = await rk.resources.registerResource({ resourceType: 'cpu', capacity: 100, quota: 40 });
 *   const a = await rk.resources.allocate({ resourceId: r.resourceId, amount: 10, owner: 'trips' });
 *   await rk.resources.release({ allocationId: a.allocationId });
 */

const { createResourceService } = require('./resourcesService');
const { createResourceMetrics } = require('./metrics');
const providers = require('./providers');
const resourcesPort = require('./resourcesPort');
const providerPort = require('./providerPort');
const { RESOURCE_EVENTS } = require('../../domain/resources/events');

function createResourcePlatform(deps = {}) {
  const metrics = deps.metrics || createResourceMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const resources = createResourceService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { resources, provider, metrics, RESOURCE_EVENTS };
}

module.exports = {
  createResourcePlatform,
  createResourceService,
  createResourceMetrics,
  providers,
  resourcesPort,
  providerPort,
  RESOURCE_EVENTS,
};
