'use strict';

/**
 * Runtime (Phase 16.2 / ADR-043 §2, §7, §8, §9) — the object returned by bootstrap. It is
 * a thin operational handle over the composed Platform (ADR-042): it supervises readiness,
 * aggregates health, verifies, and delegates shutdown to the Lifecycle Kernel. It exposes
 * ONLY the seven methods in §2.
 *
 * Restart (§7) rebuilds a fresh platform through the SAME assemble path bootstrap uses, so
 * no composition logic is duplicated here.
 */

const { RuntimeStateError, RestartError } = require('./errors');

/**
 * @param {object} deps
 * @param {object} deps.supervisor RuntimeSupervisor (persists across restarts)
 * @param {object} deps.initial    { platform, shutdownManager, context, verification, startupDurationMs }
 * @param {Function} deps.rebuild  async () => same bundle shape (fresh platform, started)
 * @param {Function} [deps.clock]
 * @param {object}   [deps.logger]
 */
function createRuntime(deps = {}) {
  const supervisor = deps.supervisor;
  const rebuild = deps.rebuild;

  const current = { ...deps.initial };
  const platform = () => current.platform;

  async function ready() {
    const sample = await supervisor.sampleHealth(current.platform);
    current.context._recordHealth(sample.health || null);
    if (!supervisor.isReady()) {
      throw new RuntimeStateError('runtime is not ready', supervisor.snapshot());
    }
    return {
      ready: true,
      state: supervisor.state(),
      startupDurationMs: current.startupDurationMs,
      health: sample.health,
    };
  }

  async function health() {
    const platformHealth = await current.platform.health();
    current.context._recordHealth(platformHealth);
    const lifecycle = current.platform.getKernel('lifecycle');
    const lifecycleHealth =
      lifecycle && typeof lifecycle.health === 'function' ? await lifecycle.health() : null;
    const sup = supervisor.snapshot();
    return {
      status: platformHealth.status,
      runtime: sup,
      platform: { status: platformHealth.status, overall: platformHealth.overall },
      lifecycle: lifecycleHealth,
      kernels: platformHealth.kernels,
      readiness: {
        ready: supervisor.isReady() && platformHealth.overall === true,
        composed: platformHealth.startupReadiness && platformHealth.startupReadiness.composed,
      },
      liveness: { live: supervisor.isLive() },
      startupDurationMs: current.startupDurationMs,
      shutdownState: {
        shuttingDown: sup.shuttingDown,
        stopped: sup.stopped,
      },
      uptimeMs: current.context.uptimeMs(),
      environment: current.context.environment,
      version: current.platform.version(),
    };
  }

  async function verify() {
    const checks = {};
    checks.bootstrapCompleted = {
      ok: Boolean(
        current.verification && current.verification.ok && current.startupDurationMs != null
      ),
    };
    let platformVerify;
    try {
      platformVerify = await current.platform.verify();
    } catch (e) {
      platformVerify = { ok: false, error: e.message };
    }
    checks.platformVerified = { ok: Boolean(platformVerify.ok) };

    const platformHealth = await current.platform.health();
    checks.allKernelsHealthy = { ok: platformHealth.overall === true };

    checks.runtimeContextValid = {
      ok: Boolean(
        current.context &&
        current.context.platform &&
        current.context.supervisor &&
        current.context.shutdownManager
      ),
    };

    const lifecycle = current.platform.getKernel('lifecycle');
    checks.lifecycleOperational = {
      ok: Boolean(lifecycle && (await safeOk(() => lifecycle.health()))),
    };
    const compatibility = current.platform.getKernel('compatibility');
    checks.compatibilityOperational = {
      ok: Boolean(compatibility && (await safeOk(() => compatibility.health()))),
    };

    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, checks };
  }

  async function shutdown(opts = {}) {
    supervisor.transition(supervisor.STATES.SHUTTING_DOWN);
    try {
      const result = await current.shutdownManager.shutdown(opts);
      supervisor.transition(supervisor.STATES.STOPPED);
      return result;
    } catch (e) {
      supervisor.recordFailure('shutdown', e);
      supervisor.transition(supervisor.STATES.FAILED);
      throw e;
    }
  }

  // ── §7 restart: verify → shutdown → rebuild → start → verify ──────────────────────
  async function restart(opts = {}) {
    if (typeof rebuild !== 'function') {
      throw new RestartError('runtime: restart requires a rebuild function');
    }
    supervisor.transition(supervisor.STATES.RESTARTING);
    supervisor.noteRestart();
    try {
      // 1. verify current runtime
      const pre = await verify();
      if (!pre.ok && opts.force !== true) {
        throw new RestartError('restart aborted: pre-restart verification failed', pre);
      }
      // 2. shutdown current platform (graceful, delegated to Lifecycle)
      await current.shutdownManager.shutdown({ timeoutMs: opts.timeoutMs, force: opts.force });
      // 3. rebuild platform + 4. start (assemble path — no duplicated composition logic)
      //    + 5. verify (assemble runs the startup verifier internally)
      const next = await rebuild();
      current.platform = next.platform;
      current.shutdownManager = next.shutdownManager;
      current.context = next.context;
      current.verification = next.verification;
      current.startupDurationMs = next.startupDurationMs;
      supervisor.transition(supervisor.STATES.READY);
      const post = await verify();
      if (!post.ok) {
        supervisor.transition(supervisor.STATES.FAILED);
        throw new RestartError('restart failed: post-restart verification failed', post);
      }
      return { ok: true, restarts: supervisor.snapshot().restarts, verification: post };
    } catch (e) {
      if (!(e instanceof RestartError)) supervisor.recordFailure('restart', e);
      if (supervisor.state() !== supervisor.STATES.FAILED) {
        supervisor.transition(supervisor.STATES.FAILED);
      }
      throw e instanceof RestartError ? e : new RestartError(`restart failed: ${e.message}`);
    }
  }

  function version() {
    return current.platform.version();
  }

  return Object.freeze({
    ready,
    health,
    verify,
    shutdown,
    restart,
    platform,
    version,
    // read-only operational accessors (not part of the mandated 7-method surface)
    context: () => current.context,
    supervisor,
  });
}

async function safeOk(fn) {
  try {
    const r = await fn();
    return r && (typeof r.ok === 'boolean' ? r.ok : true);
  } catch {
    return false;
  }
}

module.exports = { createRuntime };
