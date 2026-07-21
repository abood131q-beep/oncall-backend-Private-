'use strict';

/**
 * Memory observability provider (Phase 15.4 / ADR-033 §4) — in-process telemetry
 * store/export. Persists snapshots and records exported metric payloads. Single-
 * process; the seam a future Prometheus / OpenTelemetry / Grafana / Datadog /
 * cloud-monitoring adapter slots behind. It performs NO observability behavior (no
 * aggregation, health, diagnostics, or events) — that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { snapshots: Map(id->snapshot), exports: [] }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, { snapshots: new Map(), exports: [] });
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    exports: (namespace) => (ns.has(namespace) ? ns.get(namespace).exports.map(clone) : []),
    exportMetrics(namespace, payload) {
      bucket(namespace).exports.push(clone(payload));
      return Promise.resolve();
    },
    putSnapshot(namespace, snapshot) {
      bucket(namespace).snapshots.set(snapshot.snapshotId, clone(snapshot));
      return Promise.resolve();
    },
    getSnapshot(namespace, snapshotId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.snapshots.has(snapshotId) ? clone(b.snapshots.get(snapshotId)) : null
      );
    },
    listSnapshots(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.snapshots.values()].map(clone) : []);
    },
    health() {
      let snapshots = 0;
      let exports = 0;
      for (const b of ns.values()) {
        snapshots += b.snapshots.size;
        exports += b.exports.length;
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, snapshots, exports };
    },
  };
}

module.exports = { createMemoryProvider };
