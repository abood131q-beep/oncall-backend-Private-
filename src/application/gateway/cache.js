'use strict';

/**
 * Route cache (Phase 15.6 / ADR-035 §3) — a per-namespace cache of the route table,
 * so hot resolve/dispatch calls do not hit the provider on every request. It is
 * invalidated whenever a route in that namespace is registered, updated, or removed
 * — so a cache hit can never route on a stale table. Bounded by namespace count;
 * reports hit/miss.
 */

function createRouteCache(opts = {}) {
  const maxNamespaces = opts.maxNamespaces && opts.maxNamespaces > 0 ? opts.maxNamespaces : 1000;
  const store = new Map(); // namespace -> route model[] (insertion-ordered → FIFO)
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
  function set(namespace, routes) {
    if (store.has(namespace)) store.delete(namespace);
    store.set(namespace, routes);
    while (store.size > maxNamespaces) store.delete(store.keys().next().value);
    return routes;
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

module.exports = { createRouteCache };
