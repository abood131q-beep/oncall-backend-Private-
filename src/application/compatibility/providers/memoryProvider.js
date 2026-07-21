'use strict';

/**
 * Memory compatibility provider (Phase 15.12 / ADR-041 §4) — in-process persistence of
 * contract metadata. Single-process; the seam a future PostgreSQL / Storage / Redis /
 * MongoDB / cloud-registry adapter slots behind. It performs NO compatibility behavior
 * (no evaluation, negotiation, version resolution, deprecation, or events) — that lives
 * entirely in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(contractId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putContract(namespace, model) {
      bucket(namespace).set(model.contractId, clone(model));
      return Promise.resolve();
    },
    getContract(namespace, contractId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(contractId) ? clone(b.get(contractId)) : null);
    },
    listContracts(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeContract(namespace, contractId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(contractId) : false);
    },
    health() {
      let contracts = 0;
      for (const b of ns.values()) contracts += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, contracts };
    },
  };
}

module.exports = { createMemoryProvider };
