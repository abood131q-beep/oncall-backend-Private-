'use strict';

/**
 * Dependency graph (Phase 15.11 / ADR-040 §3) — PURE domain, deterministic. Validates
 * the component dependency graph and produces a stable startup order: a topological
 * sort (dependencies first) with ties broken by startupPriority (desc) then
 * componentId (asc). Detects missing dependencies and cycles. Shutdown order is the
 * reverse of startup. No I/O, no clock.
 */

/**
 * @param {object[]} components [{ componentId, dependencies?, startupPriority? }]
 * @returns {{ ok, order, missing, cycle }} order = startup order (deps first)
 */
function topoSort(components = []) {
  const byId = new Map();
  for (const c of components) byId.set(c.componentId, c);

  const missing = [];
  const indeg = new Map();
  const dependents = new Map(); // dep -> [dependent ids]
  for (const c of components) {
    indeg.set(c.componentId, 0);
    dependents.set(c.componentId, []);
  }
  for (const c of components) {
    for (const dep of c.dependencies || []) {
      if (!byId.has(dep)) {
        missing.push({ componentId: c.componentId, dependency: dep });
        continue;
      }
      indeg.set(c.componentId, indeg.get(c.componentId) + 1);
      dependents.get(dep).push(c.componentId);
    }
  }
  if (missing.length) return { ok: false, order: [], missing, cycle: null };

  const priorityOf = (id) => {
    const c = byId.get(id);
    return typeof c.startupPriority === 'number' ? c.startupPriority : 0;
  };
  const cmp = (a, b) => priorityOf(b) - priorityOf(a) || (a < b ? -1 : a > b ? 1 : 0);

  const ready = [...indeg.keys()].filter((id) => indeg.get(id) === 0).sort(cmp);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const dep of dependents.get(id)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) {
        ready.push(dep);
        ready.sort(cmp);
      }
    }
  }
  if (order.length < components.length) {
    const cycle = components.map((c) => c.componentId).filter((id) => !order.includes(id));
    return { ok: false, order: [], missing: [], cycle };
  }
  return { ok: true, order, missing: [], cycle: null };
}

/** The deterministic shutdown order — the reverse of the startup order. */
function shutdownOrder(components = []) {
  const s = topoSort(components);
  return s.ok ? { ok: true, order: [...s.order].reverse() } : s;
}

module.exports = { topoSort, shutdownOrder };
