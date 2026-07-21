'use strict';

/**
 * Notification store (Phase 15.1 / ADR-030) — the engine's in-process repository
 * for notification models. Distinct from the delivery Provider Port (§4): providers
 * DELIVER, this repository PERSISTS lifecycle state (status, attempts, deliveries).
 * Single-process; a future durable store (Storage kernel / Postgres) can implement
 * the same tiny interface. Deep-copies on the way in and out to prevent aliasing.
 *
 * Contract:
 *   put(namespace, model) → void
 *   get(namespace, id) → model | null
 *   list(namespace) → model[]
 *   remove(namespace, id) → boolean
 */

function createMemoryStore() {
  const ns = new Map(); // namespace -> Map(id -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : m);

  return {
    put(namespace, model) {
      bucket(namespace).set(model.notificationId, clone(model));
      return Promise.resolve();
    },
    get(namespace, id) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(id) ? clone(b.get(id)) : null);
    },
    list(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    remove(namespace, id) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(id) : false);
    },
  };
}

module.exports = { createMemoryStore };
