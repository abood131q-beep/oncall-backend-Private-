'use strict';

/**
 * Context cache (Phase 15.9 / ADR-038 §3) — a bounded cache of resolved tenant
 * contexts keyed by `namespace:tenantId:checksum`. Because the key embeds the tenant
 * checksum (which changes on any lifecycle/definition change), a cache hit can never
 * return a context built from a stale tenant. FIFO eviction keeps memory bounded;
 * reports hit/miss.
 */

function createContextCache(opts = {}) {
  const maxSize = opts.maxSize && opts.maxSize > 0 ? opts.maxSize : 5000;
  const store = new Map(); // key -> context (insertion-ordered → FIFO)
  let hits = 0;
  let misses = 0;

  function get(key) {
    if (store.has(key)) {
      hits += 1;
      return store.get(key);
    }
    misses += 1;
    return undefined;
  }
  function set(key, value) {
    if (store.has(key)) store.delete(key);
    store.set(key, value);
    while (store.size > maxSize) store.delete(store.keys().next().value);
    return value;
  }
  /** Drop cached contexts for one tenant (prefix match on `namespace:tenantId:`). */
  function invalidate(namespace, tenantId) {
    const prefix = `${namespace}:${tenantId}:`;
    for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  }
  function clear() {
    store.clear();
  }
  const stats = () => ({ size: store.size, maxSize, hits, misses });

  return { get, set, invalidate, clear, stats };
}

module.exports = { createContextCache };
