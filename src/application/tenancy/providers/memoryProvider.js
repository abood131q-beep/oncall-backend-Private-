'use strict';

/**
 * Memory multi-tenancy provider (Phase 15.9 / ADR-038 §4) — in-process persistence
 * of tenant definitions. Single-process; the seam a future PostgreSQL / Storage /
 * Redis / MongoDB / cloud-registry adapter slots behind. It performs NO tenant
 * behavior (no resolution, context, capability, lifecycle, or events) — that lives
 * in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { byId: Map(id->model), byName: Map(name->id) }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) ns.set(namespace, { byId: new Map(), byName: new Map() });
    return ns.get(namespace);
  };
  const clone = (m) => (m == null ? m : JSON.parse(JSON.stringify(m)));

  return {
    name: opts.name || 'memory',
    putTenant(namespace, model) {
      const b = bucket(namespace);
      b.byId.set(model.tenantId, clone(model));
      b.byName.set(model.tenantName, model.tenantId);
      return Promise.resolve();
    },
    getTenant(namespace, tenantId) {
      const b = ns.get(namespace);
      return Promise.resolve(b && b.byId.has(tenantId) ? clone(b.byId.get(tenantId)) : null);
    },
    getTenantByName(namespace, tenantName) {
      const b = ns.get(namespace);
      if (!b) return Promise.resolve(null);
      const id = b.byName.get(tenantName);
      return Promise.resolve(id ? clone(b.byId.get(id)) : null);
    },
    listTenants(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.byId.values()].map(clone) : []);
    },
    removeTenant(namespace, tenantId) {
      const b = ns.get(namespace);
      if (!b || !b.byId.has(tenantId)) return Promise.resolve(false);
      const model = b.byId.get(tenantId);
      b.byId.delete(tenantId);
      b.byName.delete(model.tenantName);
      return Promise.resolve(true);
    },
    health() {
      let tenants = 0;
      for (const b of ns.values()) tenants += b.byId.size;
      return { ok: true, provider: 'memory', namespaces: ns.size, tenants };
    },
  };
}

module.exports = { createMemoryProvider };
