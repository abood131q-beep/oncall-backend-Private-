'use strict';

/**
 * Memory service-discovery provider (Phase 15.5 / ADR-034 §4) — in-process
 * persistence of service definitions. Single-process; the seam a future Consul /
 * etcd / Kubernetes / DNS / cloud-registry adapter slots behind. It performs NO
 * discovery behavior (no matching, ordering, selection, health, or events) — that
 * lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(serviceId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putService(namespace, model) {
      bucket(namespace).set(model.serviceId, clone(model));
      return Promise.resolve();
    },
    getService(namespace, serviceId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(serviceId) ? clone(b.get(serviceId)) : null);
    },
    listServices(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeService(namespace, serviceId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(serviceId) : false);
    },
    health() {
      let services = 0;
      for (const b of ns.values()) services += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, services };
    },
  };
}

module.exports = { createMemoryProvider };
