'use strict';

/**
 * Usage cache (Phase 15.2 / ADR-031 §3) — a bounded, write-through cache of counter
 * state keyed by `namespace:counterKey`. It removes a provider read from the hot
 * admission path: the engine reads through the cache and, on every consume/reset,
 * writes the new state to BOTH the provider and the cache so the two never diverge
 * within a single process. FIFO eviction keeps memory bounded. Reports hit/miss.
 */

function createUsageCache(opts = {}) {
  const maxSize = opts.maxSize && opts.maxSize > 0 ? opts.maxSize : 10000;
  const store = new Map(); // key -> state (insertion-ordered → FIFO)
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
  function invalidate(key) {
    store.delete(key);
  }
  function clear() {
    store.clear();
  }
  const stats = () => ({ size: store.size, maxSize, hits, misses });

  return { get, set, invalidate, clear, stats };
}

module.exports = { createUsageCache };
