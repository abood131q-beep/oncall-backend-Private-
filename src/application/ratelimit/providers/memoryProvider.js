'use strict';

/**
 * Memory rate-limit provider (Phase 15.2 / ADR-031 §4) — in-process persistence of
 * policy definitions and counter state. Single-process; the seam a future Redis /
 * Storage / PostgreSQL / MongoDB adapter slots behind. It performs NO rate-limiting
 * behavior (no evaluation, decay, admission, or events) — that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { policies: Map(id->model), counters: Map(key->state) }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, { policies: new Map(), counters: new Map() });
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putPolicy(namespace, model) {
      bucket(namespace).policies.set(model.policyId, clone(model));
      return Promise.resolve();
    },
    getPolicy(namespace, policyId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.policies.has(policyId) ? clone(b.policies.get(policyId)) : null
      );
    },
    listPolicies(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.policies.values()].map(clone) : []);
    },
    removePolicy(namespace, policyId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.policies.delete(policyId) : false);
    },
    getCounter(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.counters.has(key) ? clone(b.counters.get(key)) : null);
    },
    putCounter(namespace, key, state) {
      bucket(namespace).counters.set(key, clone(state));
      return Promise.resolve();
    },
    resetCounter(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.counters.delete(key) : false);
    },
    health() {
      let policies = 0;
      let counters = 0;
      for (const b of ns.values()) {
        policies += b.policies.size;
        counters += b.counters.size;
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, policies, counters };
    },
  };
}

module.exports = { createMemoryProvider };
