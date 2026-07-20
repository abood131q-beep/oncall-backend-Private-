'use strict';

/**
 * Memory feature-flag provider (Phase 15.0 / ADR-029 §4) — in-process persistence
 * of flag definitions. Single-process; the seam a future Storage / PostgreSQL /
 * Redis / MongoDB / cloud-config adapter slots behind. It performs NO feature
 * behavior (no evaluation, targeting, rollout, cache, or events) — that lives in
 * the evaluation engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(name -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : m);

  return {
    name: opts.name || 'memory',
    putFlag(namespace, model) {
      bucket(namespace).set(model.name, clone(model));
      return Promise.resolve();
    },
    getFlag(namespace, name) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(name) ? clone(b.get(name)) : null);
    },
    listFlags(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeFlag(namespace, name) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(name) : false);
    },
    health() {
      let flags = 0;
      for (const b of ns.values()) flags += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, flags };
    },
  };
}

module.exports = { createMemoryProvider };
