'use strict';

/**
 * Configuration cache (Phase 14.3.2 §8) — intelligent, version-tracked cache for
 * the resolved configuration snapshot. Supports lazy loading (miss → loader),
 * explicit invalidation, per-version tracking, and reload optimization (skip a
 * rebuild when the version is unchanged). Records hit/miss for the metrics port.
 *
 * The cache holds the RESOLVED snapshot ({ values, origins, version }); the
 * service invalidates it on reload. Pure in-process; no timers, no I/O.
 */

function createConfigCache(opts = {}) {
  const metrics = opts.metrics || null;
  let entry = null; // { values, origins, version }
  let hits = 0;
  let misses = 0;

  function get() {
    if (entry) {
      hits += 1;
      if (metrics) metrics.recordCache(true);
      return entry;
    }
    misses += 1;
    if (metrics) metrics.recordCache(false);
    return null;
  }

  /** Lazy load: return cached snapshot or build+store via the loader. */
  async function getOrLoad(loader) {
    const cached = get();
    if (cached) return cached;
    const built = await loader();
    entry = built;
    return built;
  }

  function set(snapshot) {
    entry = snapshot;
    return entry;
  }

  function invalidate() {
    entry = null;
  }

  function version() {
    return entry ? entry.version : 0;
  }

  /** Reload optimization: true if the incoming version matches the cached one. */
  function isFresh(v) {
    return Boolean(entry) && entry.version === v;
  }

  function stats() {
    const total = hits + misses;
    return {
      hits,
      misses,
      hitRatio: total ? hits / total : 0,
      missRatio: total ? misses / total : 0,
      version: version(),
      cached: Boolean(entry),
    };
  }

  return { get, getOrLoad, set, invalidate, version, isFresh, stats };
}

module.exports = { createConfigCache };
