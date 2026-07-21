'use strict';

/**
 * Memory resource provider (Phase 15.10 / ADR-039 §4) — in-process persistence of
 * resource definitions + allocation state. Single-process; the seam a future
 * PostgreSQL / Storage / Redis / MongoDB / cloud-registry adapter slots behind. It
 * performs NO allocation or governance behavior (no allocate, quota, preemption, or
 * events) — that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { resources: Map(id->model), allocations: Map(id->model) }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) {
      ns.set(namespace, { resources: new Map(), allocations: new Map() });
    }
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putResource(namespace, model) {
      bucket(namespace).resources.set(model.resourceId, clone(model));
      return Promise.resolve();
    },
    getResource(namespace, resourceId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.resources.has(resourceId) ? clone(b.resources.get(resourceId)) : null
      );
    },
    listResources(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.resources.values()].map(clone) : []);
    },
    removeResource(namespace, resourceId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.resources.delete(resourceId) : false);
    },
    putAllocation(namespace, model) {
      bucket(namespace).allocations.set(model.allocationId, clone(model));
      return Promise.resolve();
    },
    getAllocation(namespace, allocationId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.allocations.has(allocationId) ? clone(b.allocations.get(allocationId)) : null
      );
    },
    listAllocations(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.allocations.values()].map(clone) : []);
    },
    health() {
      let resources = 0;
      let allocations = 0;
      for (const b of ns.values()) {
        resources += b.resources.size;
        allocations += b.allocations.size;
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, resources, allocations };
    },
  };
}

module.exports = { createMemoryProvider };
