'use strict';

/**
 * ConfigProvider PORT (Phase 14.3.2 §1/§2) — the adapter contract every
 * configuration source implements. Business logic NEVER knows which provider is
 * active; it depends only on this port. Providers are pure data sources: they
 * map a namespace of keys → values and (optionally) support change watching.
 *
 * Contract:
 *   name                       string identifier (e.g. 'env', 'file:app.json')
 *   layer                      which precedence layer this feeds (see domain/precedence)
 *   load() → Promise<object>   read the full { key: value } bag (may be cached upstream)
 *   get(key) → Promise<any>    optional fast path; defaults to load()[key]
 *   watch(cb) → unsubscribe    optional; providers that can push changes call cb()
 *
 * `assertProvider` fails fast at composition time if an adapter is incomplete.
 */

function assertProvider(p) {
  if (!p || typeof p.load !== 'function') {
    throw new Error('ConfigProvider: adapter must implement load()');
  }
  if (typeof p.name !== 'string' || !p.name) {
    throw new Error('ConfigProvider: adapter must expose a name');
  }
  if (typeof p.layer !== 'string' || !p.layer) {
    throw new Error('ConfigProvider: adapter must declare a precedence layer');
  }
  return p;
}

/**
 * Extension points for FUTURE providers (§2). These are declared, not
 * implemented — the platform can register any of them later without touching
 * business logic. Listing them documents the closed intent while keeping this
 * phase additive and dependency-free.
 */
const FUTURE_PROVIDERS = Object.freeze([
  'redis',
  'postgres',
  'consul',
  'etcd',
  'vault',
  'aws-appconfig',
  'azure-app-configuration',
  'google-runtime-config',
]);

/**
 * A guard for a not-yet-implemented provider extension point. Registering one of
 * these makes the intent explicit and throws a clear error if actually loaded,
 * rather than silently returning empty config.
 */
function futureProvider(name, layer = 'provider') {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`config: "${name}" is not a recognized future provider`);
  }
  return {
    name,
    layer,
    load() {
      return Promise.reject(
        new Error(
          `config provider "${name}" is an extension point — not implemented in Phase 14.3.2`
        )
      );
    },
    planned: true,
  };
}

module.exports = { assertProvider, FUTURE_PROVIDERS, futureProvider };
