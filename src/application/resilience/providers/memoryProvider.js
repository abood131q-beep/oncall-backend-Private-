'use strict';

/**
 * Memory resilience provider (Phase 15.7 / ADR-036 §4) — in-process persistence of
 * resilience policies + circuit/execution state. Single-process; the seam a future
 * Redis / PostgreSQL / Storage / MongoDB adapter slots behind. It performs NO
 * resilience behavior (no execution, retry, timeout, circuit logic, or events) —
 * that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { policies: Map(id->model), state: Map(key->state) }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, { policies: new Map(), state: new Map() });
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
    getState(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.state.has(key) ? clone(b.state.get(key)) : null);
    },
    putState(namespace, key, state) {
      bucket(namespace).state.set(key, clone(state));
      return Promise.resolve();
    },
    resetState(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.state.delete(key) : false);
    },
    health() {
      let policies = 0;
      let states = 0;
      for (const b of ns.values()) {
        policies += b.policies.size;
        states += b.state.size;
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, policies, states };
    },
  };
}

module.exports = { createMemoryProvider };
