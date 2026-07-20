'use strict';

/**
 * Evaluation cache (Phase 15.0 / ADR-029 §3) — a bounded, deterministic result
 * cache. Keys embed the flag CHECKSUM, so any definition change (register/update/
 * enable/disable bumps the checksum) automatically invalidates stale entries — a
 * hit can never return a result computed from an out-of-date definition. FIFO
 * eviction keeps memory bounded; no clock/TTL is needed because entries are keyed
 * by content, not time.
 */

function createEvaluationCache(opts = {}) {
  const maxSize = opts.maxSize && opts.maxSize > 0 ? opts.maxSize : 5000;
  const store = new Map(); // key -> result (insertion-ordered → FIFO)
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
  function clear() {
    store.clear();
  }
  /** Drop cached entries for one flag (prefix match on `namespace:name:`). */
  function invalidate(namespace, name) {
    const prefix = `${namespace}:${name}:`;
    for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  }
  const stats = () => ({ size: store.size, maxSize, hits, misses });

  return { get, set, clear, invalidate, stats };
}

module.exports = { createEvaluationCache };
