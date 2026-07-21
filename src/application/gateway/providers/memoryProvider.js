'use strict';

/**
 * Memory API-gateway provider (Phase 15.6 / ADR-035 §4) — in-process persistence of
 * route definitions. Single-process; the seam a future Kong / Envoy / NGINX /
 * cloud-gateway adapter slots behind. It performs NO gateway behavior (no matching,
 * dispatch, middleware, policy, or events) — that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> Map(routeId -> model)
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, new Map());
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putRoute(namespace, model) {
      bucket(namespace).set(model.routeId, clone(model));
      return Promise.resolve();
    },
    getRoute(namespace, routeId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.has(routeId) ? clone(b.get(routeId)) : null);
    },
    listRoutes(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.values()].map(clone) : []);
    },
    removeRoute(namespace, routeId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.delete(routeId) : false);
    },
    health() {
      let routes = 0;
      for (const b of ns.values()) routes += b.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, routes };
    },
  };
}

module.exports = { createMemoryProvider };
