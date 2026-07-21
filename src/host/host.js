'use strict';

/**
 * Host (Phase 16.3 / ADR-044 §1, §5, §8, §9) — the object returned by createHost. It
 * manages ONE Bootstrap Runtime (ADR-043) plus any number of hosted services, preserving
 * complete isolation: services never see each other, and each receives only the context
 * slices it declared. The host delegates platform lifecycle to the Runtime and orchestrates
 * hosted-service startup/shutdown ordering itself.
 *
 * Restart rebuilds the Runtime's platform (via runtime.restart(), ADR-043) and then
 * re-derives the host context + lifecycle from the fresh platform — never duplicating
 * composition or runtime logic.
 */

const { createHostLifecycle } = require('./hostLifecycle');
const { HostStateError, HostVerificationError } = require('./errors');

function createHostObject(deps = {}) {
  const runtime = deps.runtime;
  const registry = deps.registry;
  const supervisor = deps.supervisor;
  const makeContext = deps.makeContext;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };

  // Current operational surfaces — rebuilt on restart when the platform changes.
  const current = { context: makeContext(), lifecycle: null };
  current.lifecycle = createHostLifecycle({
    runtime,
    registry,
    context: current.context,
    supervisor,
    clock,
    logger: log,
  });
  let startupDurationMs = null;

  function rebuildLifecycle() {
    current.context = makeContext();
    current.lifecycle = createHostLifecycle({
      runtime,
      registry,
      context: current.context,
      supervisor,
      clock,
      logger: log,
    });
  }

  // ── §3 register / unregister ──────────────────────────────────────────────────────
  async function register(service) {
    const descriptor = registry.register(service);
    supervisor.setServiceState(descriptor.id, supervisor.SERVICE_STATES.REGISTERED);
    // If the host is already running, start the newly registered service immediately;
    // its declared dependencies must already be started.
    if (supervisor.isReady()) {
      for (const dep of descriptor.dependsOn) {
        if (supervisor.serviceStateOf(dep) !== supervisor.SERVICE_STATES.STARTED) {
          throw new HostStateError(
            `host: cannot start "${descriptor.id}" — dependency "${dep}" is not started`
          );
        }
      }
      await current.lifecycle.startServices([descriptor.id]);
    }
    return descriptor;
  }

  async function unregister(id) {
    if (registry.has(id) && supervisor.serviceStateOf(id) === supervisor.SERVICE_STATES.STARTED) {
      const { service } = registry.resolve(id);
      try {
        await service.stop();
      } catch (e) {
        supervisor.recordFailure('shutdown', e, id);
      }
      supervisor.setServiceState(id, supervisor.SERVICE_STATES.STOPPED);
    }
    return registry.unregister(id);
  }

  // ── §5 start / stop ─────────────────────────────────────────────────────────────────
  async function start() {
    const result = await current.lifecycle.start();
    startupDurationMs = result.startupDurationMs;
    return result;
  }

  async function stop(opts = {}) {
    return current.lifecycle.shutdown(opts);
  }

  // ── restart: stop services → runtime.restart() → rebuild → start services ──────────
  async function restart(opts = {}) {
    supervisor.transition(supervisor.STATES.RESTARTING);
    supervisor.noteRestart();
    try {
      const g = current.lifecycle.graph();
      await current.lifecycle.stopServices(g.shutdownOrder);
      await runtime.restart(opts); // platform rebuilt + re-verified (ADR-043)
      rebuildLifecycle(); // re-derive host context/lifecycle from the fresh platform
      const started = await current.lifecycle.startServices(current.lifecycle.graph().order);
      supervisor.transition(supervisor.STATES.READY);
      return { ok: true, restarts: supervisor.snapshot().restarts, started };
    } catch (e) {
      supervisor.recordFailure('restart', e);
      supervisor.transition(supervisor.STATES.FAILED);
      throw e;
    }
  }

  // ── §8 health ───────────────────────────────────────────────────────────────────────
  async function health() {
    const runtimeHealth = await runtime.health();
    const services = {};
    for (const { service, descriptor } of registry.list()) {
      const startedOnly = supervisor.serviceStateOf(descriptor.id);
      if (startedOnly !== supervisor.SERVICE_STATES.STARTED) {
        services[descriptor.id] = { ok: true, state: startedOnly || 'registered', skipped: true };
        continue;
      }
      try {
        const h = await service.health();
        services[descriptor.id] = h && typeof h.ok === 'boolean' ? h : { ok: Boolean(h) };
      } catch (e) {
        services[descriptor.id] = { ok: false, error: e.message };
        supervisor.recordFailure('health', e, descriptor.id);
      }
    }
    const runtimeOk = runtimeHealth.status === 'healthy';
    const assessment = supervisor.assess({
      runtimeOk,
      serviceHealth: services,
    });
    const sup = supervisor.snapshot();
    return {
      status: assessment.overall ? 'healthy' : sup.failed ? 'unhealthy' : 'degraded',
      host: sup,
      runtime: { status: runtimeHealth.status, overall: runtimeOk },
      services,
      readiness: { ready: supervisor.isReady() && assessment.overall },
      liveness: { live: supervisor.isLive() },
      startupDurationMs,
      shutdownState: { shuttingDown: sup.shuttingDown, stopped: sup.stopped },
      unhealthyServices: assessment.unhealthyServices,
      environment: current.context.environment,
      version: runtime.version(),
    };
  }

  // ── §9 verify ─────────────────────────────────────────────────────────────────────
  async function verify() {
    const checks = {};
    const runtimeHealth = await runtime.health();
    checks.runtimeHealthy = { ok: runtimeHealth.status === 'healthy' };

    const serviceVerifications = {};
    let allVerified = true;
    for (const { service, descriptor } of registry.list()) {
      try {
        const v = await service.verify();
        const ok = v && typeof v.ok === 'boolean' ? v.ok : Boolean(v);
        serviceVerifications[descriptor.id] = ok;
        if (!ok) allVerified = false;
      } catch (e) {
        serviceVerifications[descriptor.id] = false;
        allVerified = false;
        void e;
      }
    }
    checks.allServicesVerified = { ok: allVerified, services: serviceVerifications };

    let g = null;
    try {
      g = current.lifecycle.graph();
      checks.dependencyGraphValid = { ok: true };
    } catch (e) {
      checks.dependencyGraphValid = { ok: false, error: e.message };
    }
    const count = registry.descriptors().length;
    checks.startupOrderValid = { ok: Boolean(g) && g.order.length === count };
    checks.shutdownOrderValid = {
      ok:
        Boolean(g) &&
        g.shutdownOrder.length === count &&
        g.shutdownOrder[0] === g.order[g.order.length - 1],
    };
    checks.contractsValid = { ok: registry.verify().ok };

    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, checks };
  }

  function assertVerified(result) {
    if (!result.ok) throw new HostVerificationError('host verification failed', result.checks);
    return result;
  }

  function listServices() {
    return registry.descriptors();
  }
  function getService(id) {
    return registry.has(id) ? registry.resolve(id).service : null;
  }

  return Object.freeze({
    register,
    unregister,
    start,
    stop,
    restart,
    health,
    verify,
    listServices,
    getService,
    runtime: () => runtime,
    context: () => current.context,
    version: () => runtime.version(),
    supervisor,
    assertVerified,
  });
}

module.exports = { createHostObject };
