'use strict';

/**
 * Memory service-mesh provider (Phase 15.8 / ADR-037 §4) — in-process persistence of
 * connection definitions. Single-process; the seam a future Istio / Linkerd / Consul
 * Connect / cloud-mesh adapter slots behind. It performs NO mesh behavior (no
 * invocation, routing, policy, or events) — that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(connectionId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putConnection(namespace, model) {
      bucket(namespace).set(model.connectionId, clone(model));
      return Promise.resolve();
    },
    getConnection(namespace, connectionId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(connectionId) ? clone(b.get(connectionId)) : null);
    },
    listConnections(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeConnection(namespace, connectionId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(connectionId) : false);
    },
    health() {
      let connections = 0;
      for (const b of ns.values()) connections += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, connections };
    },
  };
}

module.exports = { createMemoryProvider };
