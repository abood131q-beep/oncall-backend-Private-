'use strict';

/**
 * Provider cache (Phase 15.5 / ADR-034 §3) — a per-namespace cache of the service
 * list, so hot discover/resolve calls do not hit the provider on every request. It
 * is invalidated whenever a service in that namespace is registered, updated, its
 * health changes, or it is removed — so a cache hit can never return a stale set.
 * Bounded by namespace count; reports hit/miss.
 */

function createDiscoveryCache(opts = {}) {
  const maxNamespaces = opts.maxNamespaces && opts.maxNamespaces > 0 ? opts.maxNamespaces : 1000;
  const store = new Map(); // namespace -> service model[] (insertion-ordered → FIFO)
  let hits = 0;
  let misses = 0;

  function get(namespace) {
    if (store.has(namespace)) {
      hits += 1;
      return store.get(namespace);
    }
    misses += 1;
    return undefined;
  }
  function set(namespace, services) {
    if (store.has(namespace)) store.delete(namespace);
    store.set(namespace, services);
    while (store.size > maxNamespaces) store.delete(store.keys().next().value);
    return services;
  }
  function invalidate(namespace) {
    store.delete(namespace);
  }
  function clear() {
    store.clear();
  }
  const stats = () => ({ namespaces: store.size, maxNamespaces, hits, misses });

  return { get, set, invalidate, clear, stats };
}

module.exports = { createDiscoveryCache };
