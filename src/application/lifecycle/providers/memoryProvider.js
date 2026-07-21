'use strict';

/**
 * Memory lifecycle provider (Phase 15.11 / ADR-040 §4) — in-process persistence of
 * component lifecycle metadata. Single-process; the seam a future PostgreSQL /
 * Storage / Redis / MongoDB / cloud-registry adapter slots behind. It performs NO
 * orchestration behavior (no ordering, transition validation, or events) — that
 * lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(componentId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putComponent(namespace, model) {
      bucket(namespace).set(model.componentId, clone(model));
      return Promise.resolve();
    },
    getComponent(namespace, componentId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(componentId) ? clone(b.get(componentId)) : null);
    },
    listComponents(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeComponent(namespace, componentId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(componentId) : false);
    },
    health() {
      let components = 0;
      for (const b of ns.values()) components += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, components };
    },
  };
}

module.exports = { createMemoryProvider };
