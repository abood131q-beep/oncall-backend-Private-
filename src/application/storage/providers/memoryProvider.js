'use strict';

/**
 * Memory storage provider (Phase 14.3.4 §4) — in-process record store backing any
 * namespace. Ideal for tests, caches, and as the seam a future durable provider
 * slots behind. Records are cloned on write/read so the store cannot be mutated
 * by reference from outside. `writeBatch` applies atomically (all-or-nothing via
 * a staged copy).
 */

function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  return JSON.parse(JSON.stringify(v));
}
function cloneRecord(r) {
  return r ? { ...r, value: clone(r.value), metadata: { ...r.metadata } } : r;
}

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(key -> record)
  const _bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };

  return {
    name: opts.name || 'memory',
    read(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(key) ? cloneRecord(b.get(key)) : null);
    },
    write(namespace, key, record) {
      _bucket(namespace).set(key, cloneRecord(record));
      return Promise.resolve();
    },
    remove(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(key) : false);
    },
    has(namespace, key) {
      const b = ns.get(namespace);
      return Promise.resolve(Boolean(b && b.has(key)));
    },
    scan(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(cloneRecord) : []);
    },
    writeBatch(ops) {
      // Atomic: validate then apply to a working copy, then commit.
      const staged = new Map(); // namespace -> Map (shallow copy of affected)
      const stagedFor = (namespace) => {
        if (!staged.has(namespace)) staged.set(namespace, new Map(_bucket(namespace)));
        return staged.get(namespace);
      };
      for (const op of ops) {
        const bucket = stagedFor(op.namespace);
        if (op.op === 'put') bucket.set(op.key, cloneRecord(op.record));
        else if (op.op === 'del') bucket.delete(op.key);
        else return Promise.reject(new Error(`memoryProvider: unknown batch op "${op.op}"`));
      }
      for (const [namespace, bucket] of staged) ns.set(namespace, bucket);
      return Promise.resolve();
    },
    health() {
      let records = 0;
      for (const b of ns.values()) records += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, records };
    },
  };
}

module.exports = { createMemoryProvider };
