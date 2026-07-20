'use strict';

/**
 * Policy Platform — composition entry point (Phase 14.6 / ADR-025). Wires the
 * service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the policy engine is instantiated.
 *
 *   const pol = createPolicyPlatform({ publisher });
 *   await pol.policy.register({ name: 'allow-vip', scope: 'trip:create', effect: 'allow',
 *     condition: { field: 'user.tier', op: 'eq', value: 'vip' } });
 *   pol.policy.evaluate({ scope: 'trip:create', user: { tier: 'vip' } }); // { allowed: true }
 */

const { createPolicyService } = require('./policyService');
const { createPolicyMetrics } = require('./metrics');
const providers = require('./providers');
const policyPort = require('./policyPort');
const providerPort = require('./providerPort');
const { POLICY_EVENTS } = require('../../domain/policy/events');

function createPolicyPlatform(deps = {}) {
  const metrics = deps.metrics || createPolicyMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const policy = createPolicyService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    strategy: deps.strategy,
    cache: deps.cache,
    idFactory: deps.idFactory,
  });
  return { policy, provider, metrics, POLICY_EVENTS };
}

module.exports = {
  createPolicyPlatform,
  createPolicyService,
  createPolicyMetrics,
  providers,
  policyPort,
  providerPort,
  POLICY_EVENTS,
};
