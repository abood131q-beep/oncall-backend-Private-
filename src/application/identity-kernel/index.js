'use strict';

/**
 * Identity Platform — composition entry point (Phase 14.8 / ADR-027). Wires the
 * service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the identity kernel is instantiated. It is a
 * NEW kernel under `identity-kernel/`; the application's existing identity
 * bounded context is untouched.
 *
 *   const idk = createIdentityPlatform({ publisher });
 *   await idk.identity.register({ principal: 'u1', credentials: { secret: 'pw' }, roles: ['rider'] });
 *   const { session, context } = await idk.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } });
 *   const r = await idk.identity.resolve({ sessionId: session.sessionId });
 */

const { createIdentityService } = require('./identityService');
const { createIdentityMetrics } = require('./metrics');
const providers = require('./providers');
const identityPort = require('./identityPort');
const providerPort = require('./providerPort');
const { IDENTITY_EVENTS } = require('../../domain/identity-kernel/events');

function createIdentityPlatform(deps = {}) {
  const metrics = deps.metrics || createIdentityMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const identity = createIdentityService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    tokenFactory: deps.tokenFactory,
    sessionTtlMs: deps.sessionTtlMs,
    historyLimit: deps.historyLimit,
  });
  return { identity, provider, metrics, IDENTITY_EVENTS };
}

module.exports = {
  createIdentityPlatform,
  createIdentityService,
  createIdentityMetrics,
  providers,
  identityPort,
  providerPort,
  IDENTITY_EVENTS,
};
