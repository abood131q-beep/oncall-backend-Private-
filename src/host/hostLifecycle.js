'use strict';

/**
 * Host Lifecycle (Phase 16.3 / ADR-044 §5) — orchestrates startup and shutdown of the
 * Runtime and the hosted services, preserving strict ordering:
 *
 *   Startup:  Runtime → Hosted Services (dependency order)
 *   Shutdown: Hosted Services (reverse order) → Runtime
 *
 * Platform lifecycle is DELEGATED to the Bootstrap Runtime (ADR-043) via runtime.ready()
 * / runtime.shutdown(); the host never re-implements platform or kernel lifecycle. Hosted
 * services are managed independently: each is started/stopped through its §2 contract,
 * receiving only the context slices it declared. Service ordering reuses the deterministic
 * dependency graph from ADR-042 (no duplicated graph logic).
 */

const { buildDependencyGraph } = require('../platform/dependencyGraph');
const { ServiceDependencyError, ServiceLifecycleError } = require('./errors');

function createHostLifecycle(deps = {}) {
  const runtime = deps.runtime;
  const registry = deps.registry;
  const context = deps.context;
  const supervisor = deps.supervisor;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };

  /** Build + validate the hosted-service dependency graph (deterministic). */
  function graph() {
    // Adapt hosted-service descriptors (keyed by id) to the platform graph's { name }
    // shape; ordering is returned in terms of service ids.
    const nodes = registry.descriptors().map((d) => ({
      name: d.id,
      dependsOn: d.dependsOn,
      ports: [],
    }));
    const g = buildDependencyGraph(nodes);
    if (!g.ok) {
      const cyc = g.issues.find((i) => i.reason === 'circular dependency');
      throw new ServiceDependencyError(
        cyc
          ? 'host: circular service dependency detected'
          : 'host: service dependency graph invalid',
        g.issues
      );
    }
    return g;
  }

  async function startServices(order) {
    const started = [];
    for (const id of order) {
      const { service, descriptor } = registry.resolve(id);
      supervisor.setServiceState(id, supervisor.SERVICE_STATES.STARTING);
      try {
        await service.start(context.scopeFor(descriptor.needs));
        supervisor.setServiceState(id, supervisor.SERVICE_STATES.STARTED);
        started.push(id);
      } catch (e) {
        supervisor.setServiceState(id, supervisor.SERVICE_STATES.FAILED);
        supervisor.recordFailure('startup', e, id);
        throw new ServiceLifecycleError(`host: service "${id}" failed to start: ${e.message}`, {
          service: id,
        });
      }
    }
    return started;
  }

  async function stopServices(order) {
    const stopped = [];
    const errors = [];
    for (const id of order) {
      if (!registry.has(id)) continue;
      const { service } = registry.resolve(id);
      supervisor.setServiceState(id, supervisor.SERVICE_STATES.STOPPING);
      try {
        await service.stop();
        supervisor.setServiceState(id, supervisor.SERVICE_STATES.STOPPED);
        stopped.push(id);
      } catch (e) {
        // Graceful shutdown continues stopping the rest, but records the failure.
        supervisor.setServiceState(id, supervisor.SERVICE_STATES.FAILED);
        supervisor.recordFailure('shutdown', e, id);
        errors.push({ service: id, error: e.message });
      }
    }
    return { stopped, errors };
  }

  // ── §5 startup: Runtime → Hosted Services ─────────────────────────────────────────
  async function start() {
    const startedAt = clock();
    supervisor.transition(supervisor.STATES.STARTING);
    try {
      // 1. Runtime first (delegated to ADR-043 — already bootstrapped; confirm ready).
      await runtime.ready();
      // 2. Hosted services in dependency order.
      const g = graph();
      const started = await startServices(g.order);
      supervisor.transition(supervisor.STATES.READY);
      return { ok: true, order: g.order, started, startupDurationMs: clock() - startedAt };
    } catch (e) {
      supervisor.transition(supervisor.STATES.FAILED);
      throw e;
    }
  }

  // ── §5 shutdown: Hosted Services (reverse) → Runtime ──────────────────────────────
  async function shutdown(opts = {}) {
    supervisor.transition(supervisor.STATES.SHUTTING_DOWN);
    let g;
    try {
      g = graph();
    } catch (e) {
      // If the graph can't be built, fall back to reverse registration order.
      g = {
        shutdownOrder: registry
          .descriptors()
          .map((d) => d.id)
          .reverse(),
      };
      log.warn('host: shutdown using registration order', { reason: e.message });
    }
    // 1. Hosted services in reverse dependency order.
    const { stopped, errors } = await stopServices(g.shutdownOrder);
    // 2. Runtime last (delegated to ADR-043 — graceful/forced/timeout policy lives there).
    const runtimeResult = await runtime.shutdown(opts);
    supervisor.transition(supervisor.STATES.STOPPED);
    return { ok: errors.length === 0, stopped, serviceErrors: errors, runtime: runtimeResult };
  }

  return { start, shutdown, graph, startServices, stopServices };
}

module.exports = { createHostLifecycle };
