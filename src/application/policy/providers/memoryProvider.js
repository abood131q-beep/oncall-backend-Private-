'use strict';

/**
 * Memory policy provider (Phase 14.6 / ADR-025 §4) — in-process store of policy
 * DEFINITIONS (models) only. It never evaluates. Single-process; the seam a
 * future OPA/Cedar/Casbin definition store slots behind.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(policyId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : m);

  return {
    name: opts.name || 'memory',
    put(namespace, model) {
      bucket(namespace).set(model.policyId, clone(model));
      return Promise.resolve();
    },
    get(namespace, policyId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(policyId) ? clone(b.get(policyId)) : null);
    },
    remove(namespace, policyId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(policyId) : false);
    },
    list(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    health() {
      let policies = 0;
      for (const b of ns.values()) policies += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, policies };
    },
  };
}

module.exports = { createMemoryProvider };
