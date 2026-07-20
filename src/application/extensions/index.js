'use strict';

/**
 * Extension Platform — composition entry point (Phase 14.2).
 * Wires the registry with a hook bus + metrics; exposes the whole platform as
 * one factory. Purely additive: nothing here is imported by hot paths, so the
 * platform runs byte-identically whether or not extensions are loaded.
 */

const { createExtensionRegistry, STATES } = require('./registry');
const { createHookBus } = require('./hookBus');
const { createExtensionMetrics } = require('./metrics');
const { resolve } = require('./dependencyResolver');
const { createSandbox } = require('./sandbox');

function createExtensionPlatform(deps = {}) {
  const metrics = deps.metrics || createExtensionMetrics({ clock: deps.clock });
  const hookBus =
    deps.hookBus ||
    createHookBus({
      metrics,
      logger: deps.logger,
      clock: deps.clock,
      timeoutMs: deps.hookTimeoutMs,
      breakerThreshold: deps.breakerThreshold,
      breakerCooldownMs: deps.breakerCooldownMs,
    });
  const registry = createExtensionRegistry({
    hookBus,
    metrics,
    portFactories: deps.portFactories,
    env: deps.env,
    signatureVerifier: deps.signatureVerifier,
    requireSignature: deps.requireSignature,
    logger: deps.logger,
    clock: deps.clock,
  });

  return {
    registry,
    hookBus,
    metrics,
    resolveDependencies: (manifests) => resolve(manifests, deps.env || {}),
    STATES,
  };
}

module.exports = { createExtensionPlatform, createSandbox, resolve, STATES };
