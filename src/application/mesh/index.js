'use strict';

/**
 * Service Mesh Platform — composition entry point (Phase 15.8 / ADR-037). Wires the
 * service with a provider + metrics + (optional) injected kernel ports and returns
 * the Kernel Service as one factory. Purely additive: nothing here is on a hot path,
 * so the platform runs byte-identically whether or not the mesh kernel is
 * instantiated.
 *
 *   const mk = createMeshPlatform({ publisher, ports: { identity, policy, resilience, ratelimit, discovery } });
 *   await mk.mesh.registerPolicy({ sourceService: 'gateway', destinationService: 'trips', securityPolicy: { requireIdentity: true } });
 *   await mk.mesh.connect({ connectionId });
 *   const r = await mk.mesh.invoke({ connectionId, fn: callTrips, token });
 */

const { createMeshService } = require('./meshService');
const { createMeshMetrics } = require('./metrics');
const providers = require('./providers');
const meshPort = require('./meshPort');
const providerPort = require('./providerPort');
const { MESH_EVENTS } = require('../../domain/mesh/events');

function createMeshPlatform(deps = {}) {
  const metrics = deps.metrics || createMeshMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const mesh = createMeshService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
    ports: deps.ports,
  });
  return { mesh, provider, metrics, MESH_EVENTS };
}

module.exports = {
  createMeshPlatform,
  createMeshService,
  createMeshMetrics,
  providers,
  meshPort,
  providerPort,
  MESH_EVENTS,
};
