'use strict';

/**
 * Deployment Planner (Phase 16.4 / ADR-045 §4) — generates deterministic deployment plans
 * and VALIDATES them. It NEVER executes a plan; it only produces + checks one:
 *   • service dependencies    — declared deps are present/registered in the host
 *   • deployment order        — deterministic (dependencies first)
 *   • rollback order          — exact reverse of deployment order
 *   • version compatibility   — via the Compatibility Kernel (ADR-041) when available
 *   • resource availability   — via the Resource Management Kernel (ADR-039) when available
 *
 * Ordering reuses ADR-042's dependency graph over the host's service descriptors plus the
 * target service (no duplicated graph logic).
 */

const { buildDependencyGraph } = require('../platform/dependencyGraph');
const { DeploymentPlanError } = require('./errors');

function createDeploymentPlanner(deps = {}) {
  const host = deps.host;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };

  /** Build a plan for deploying `service` (a §2 host service) at `version`. */
  async function plan({ service, version, strategy, contractId, resourceRequest } = {}) {
    if (!service || typeof service.id !== 'function') {
      throw new DeploymentPlanError('planner: a hosted service (ADR-044 contract) is required');
    }
    const id = service.id();
    const targetVersion = version || service.version();
    const declaredDeps = service.dependencies();

    // Node set = existing host services + the target (so ordering is deterministic even
    // when the target is not yet registered).
    const existing = host.listServices();
    const nodes = existing
      .filter((d) => d.id !== id)
      .map((d) => ({ name: d.id, dependsOn: d.dependsOn, ports: [] }));
    nodes.push({ name: id, dependsOn: declaredDeps, ports: [] });
    const graph = buildDependencyGraph(nodes);

    const checks = {};

    // service dependencies present
    const known = new Set(nodes.map((n) => n.name));
    const missing = declaredDeps.filter((d) => !known.has(d));
    checks.dependencies = { ok: missing.length === 0, missing };

    // deployment order (deps first) + rollback order (reverse), scoped to target + its deps
    let deployOrder = [];
    let rollbackOrder = [];
    if (graph.ok) {
      const needed = closure(id, nodes);
      deployOrder = graph.order.filter((n) => needed.has(n));
      rollbackOrder = [...deployOrder].reverse();
      checks.deploymentOrder = {
        ok: deployOrder[deployOrder.length - 1] === id,
        order: deployOrder,
      };
      checks.rollbackOrder = { ok: rollbackOrder[0] === id, order: rollbackOrder };
    } else {
      checks.deploymentOrder = { ok: false, issues: graph.issues };
      checks.rollbackOrder = { ok: false };
    }

    // version compatibility (Compatibility Kernel, ADR-041) — best-effort, non-destructive
    checks.versionCompatibility = await checkVersionCompatibility(id, targetVersion, contractId);

    // resource availability (Resource Management Kernel, ADR-039) — best-effort
    checks.resourceAvailability = await checkResourceAvailability(resourceRequest);

    const ok = Object.values(checks).every((c) => c.ok);
    return Object.freeze({
      service: id,
      version: targetVersion,
      strategy: strategy || 'immediate',
      deployOrder,
      rollbackOrder,
      checks,
      ok,
      createdAt: clock(),
    });
  }

  function kernel(name) {
    try {
      const platform = host.runtime().platform();
      return platform && typeof platform.getKernel === 'function' ? platform.getKernel(name) : null;
    } catch {
      return null;
    }
  }

  async function checkVersionCompatibility(serviceId, version, contractId) {
    const compat = kernel('compatibility');
    if (!compat || !contractId) return { ok: true, note: 'no compatibility contract declared' };
    try {
      const decision = await compat.evaluate({ contractId, version });
      return { ok: Boolean(decision.compatible), decision };
    } catch (e) {
      log.warn('planner: compatibility check errored', { error: e.message });
      return { ok: false, error: e.message };
    }
  }

  async function checkResourceAvailability(resourceRequest) {
    const resources = kernel('resources');
    if (!resources || typeof resources.health !== 'function') {
      return { ok: true, note: 'no resource kernel' };
    }
    try {
      const h = await resources.health();
      return { ok: Boolean(h && h.ok), request: resourceRequest || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { plan };
}

/** Transitive dependency closure of `id` within the node set (id + all its deps). */
function closure(id, nodes) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n) || !byName.has(n)) return;
    seen.add(n);
    for (const d of byName.get(n).dependsOn) visit(d);
  };
  visit(id);
  return seen;
}

module.exports = { createDeploymentPlanner };
