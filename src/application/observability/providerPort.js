'use strict';

/**
 * ObservabilityProvider PORT (Phase 15.4 / ADR-033 §4) — STORE or EXPORT telemetry
 * ONLY. A provider persists snapshots and/or exports metrics to an external system;
 * it never aggregates, computes health, generates diagnostics, or emits kernel
 * events — all observability behavior lives in the engine, so engine behavior is
 * identical regardless of provider. NOT Prometheus/OpenTelemetry/Grafana/Datadog —
 * those are declared extension points behind this same contract.
 *
 * Contract (all async unless noted):
 *   name
 *   exportMetrics(namespace, payload) → void      // push telemetry outward
 *   putSnapshot(namespace, snapshot) → void        // persist a snapshot
 *   getSnapshot(namespace, snapshotId) → snapshot | null
 *   listSnapshots(namespace) → snapshot[]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'exportMetrics',
  'putSnapshot',
  'getSnapshot',
  'listSnapshots',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ObservabilityProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ObservabilityProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'prometheus',
  'opentelemetry',
  'grafana',
  'datadog',
  'cloud-monitoring',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`observability: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `observability provider "${name}" is an extension point — not implemented in Phase 15.4`
    );
  };
  return {
    name,
    planned: true,
    exportMetrics: notImpl,
    putSnapshot: notImpl,
    getSnapshot: notImpl,
    listSnapshots: () => [],
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
