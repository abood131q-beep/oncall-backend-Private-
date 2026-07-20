'use strict';

/**
 * Memory audit provider (Phase 14.7 / ADR-026 §4) — in-process, APPEND-ONLY store
 * of immutable audit records. Single-process; the seam a future Storage/Postgres/
 * MongoDB/object-storage append log slots behind. It never updates or deletes.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { list: record[], byId: Map(auditId -> record) }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, { list: [], byId: new Map() });
    return ns.get(namespace);
  };

  return {
    name: opts.name || 'memory',
    append(namespace, record) {
      const b = bucket(namespace);
      b.list.push(record); // record is already frozen by the domain
      b.byId.set(record.auditId, record);
      return Promise.resolve();
    },
    scan(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.list.slice() : []);
    },
    get(namespace, auditId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.byId.has(auditId) ? b.byId.get(auditId) : null);
    },
    count(namespace) {
      const b = ns.get(namespace);
      return b ? b.list.length : 0;
    },
    tail(namespace) {
      const b = ns.get(namespace);
      return b && b.list.length ? b.list[b.list.length - 1] : null;
    },
    health() {
      let records = 0;
      for (const b of ns.values()) records += b.list.length;
      return { ok: true, provider: 'memory', namespaces: ns.size, records };
    },
  };
}

module.exports = { createMemoryProvider };
