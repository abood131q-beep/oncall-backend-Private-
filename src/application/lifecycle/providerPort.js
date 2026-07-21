'use strict';

/**
 * LifecycleProvider PORT (Phase 15.11 / ADR-040 §4) — persistence ONLY. Providers
 * store lifecycle METADATA (component definitions + last-known state); they never
 * orchestrate startup/shutdown, order dependencies, validate transitions, or emit
 * events — all orchestration lives in the engine, so engine behavior is identical
 * regardless of provider. NOT systemd/K8s Operators/Docker Compose/PM2 — PostgreSQL/
 * Storage/Redis/MongoDB/cloud registries are declared extension points.
 *
 * Contract (all async unless noted):
 *   name
 *   putComponent(namespace, model) → void
 *   getComponent(namespace, componentId) → model | null
 *   listComponents(namespace) → model[]
 *   removeComponent(namespace, componentId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putComponent',
  'getComponent',
  'listComponents',
  'removeComponent',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('LifecycleProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`LifecycleProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'postgresql',
  'storage', // Enterprise Storage Platform (ADR-021)
  'redis',
  'mongodb',
  'cloud-registry',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`lifecycle: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `lifecycle provider "${name}" is an extension point — not implemented in Phase 15.11`
    );
  };
  return {
    name,
    planned: true,
    putComponent: notImpl,
    getComponent: notImpl,
    listComponents: () => [],
    removeComponent: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
