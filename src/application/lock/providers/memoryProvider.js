'use strict';

/**
 * Memory lock provider (Phase 14.3.5 §4) — in-process lock store backing any
 * namespace. Single-process only (NOT distributed coordination). Stores the lock
 * record's serializable model; the service owns all lease/ownership logic.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(lockId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m ? { ...m, metadata: { ...m.metadata } } : m);

  return {
    name: opts.name || 'memory',
    read(namespace, lockId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(lockId) ? clone(b.get(lockId)) : null);
    },
    write(namespace, lockId, model) {
      bucket(namespace).set(lockId, clone(model));
      return Promise.resolve();
    },
    remove(namespace, lockId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(lockId) : false);
    },
    scan(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    health() {
      let locks = 0;
      for (const b of ns.values()) locks += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, locks };
    },
  };
}

module.exports = { createMemoryProvider };
