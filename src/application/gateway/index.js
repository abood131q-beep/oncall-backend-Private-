'use strict';

/**
 * API Gateway Platform — composition entry point (Phase 15.6 / ADR-035). Wires the
 * service with a provider + route cache + metrics + (optional) injected kernel ports,
 * and returns the Kernel Service as one factory. Purely additive: nothing here is on
 * a hot path, so the platform runs byte-identically whether or not the gateway kernel
 * is instantiated.
 *
 *   const gk = createGatewayPlatform({ publisher, ports: { identity, policy, ratelimit, features, discovery } });
 *   gk.gateway.registerRoute({ method: 'GET', path: '/trips/:id', targetService: 'trips' });
 *   const r = await gk.gateway.dispatch({ method: 'GET', path: '/trips/42' });
 */

const { createGatewayService } = require('./gatewayService');
const { createGatewayMetrics } = require('./metrics');
const { createRouteCache } = require('./cache');
const providers = require('./providers');
const gatewayPort = require('./gatewayPort');
const providerPort = require('./providerPort');
const { GATEWAY_EVENTS } = require('../../domain/gateway/events');

function createGatewayPlatform(deps = {}) {
  const metrics = deps.metrics || createGatewayMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const cache = deps.cache || createRouteCache({ maxNamespaces: deps.cacheMaxNamespaces });
  const gateway = createGatewayService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
    ports: deps.ports,
  });
  return { gateway, provider, cache, metrics, GATEWAY_EVENTS };
}

module.exports = {
  createGatewayPlatform,
  createGatewayService,
  createGatewayMetrics,
  createRouteCache,
  providers,
  gatewayPort,
  providerPort,
  GATEWAY_EVENTS,
};
