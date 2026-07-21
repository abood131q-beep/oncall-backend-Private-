'use strict';

/**
 * Shutdown Manager (Phase 16.2 / ADR-043 §6) — orchestrates platform shutdown by
 * DELEGATING to the Lifecycle Kernel (ADR-040) via `platform.shutdown()`. It never
 * re-implements shutdown ordering; it only adds runtime policy: graceful shutdown, forced
 * shutdown, a shutdown timeout, and shutdown verification.
 *
 *   graceful  — await platform.shutdown() (Lifecycle stops kernels in reverse order)
 *   timeout   — bound the wait; on expiry either force or fail
 *   forced    — resolve as forced when the graceful path exceeds the timeout
 *   verify    — confirm the Lifecycle kernel reports no started components afterward
 */

const { ShutdownError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 30000;

function createShutdownManager(deps = {}) {
  const platform = deps.platform;
  if (!platform || typeof platform.shutdown !== 'function') {
    throw new ShutdownError('shutdownManager: a platform with shutdown() is required');
  }
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };
  const defaultTimeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;

  // A cancellable timeout: resolves { timedOut:true } after ms, and exposes cancel() so a
  // fast graceful shutdown never leaves a dangling timer holding the event loop open.
  const makeTimer =
    deps.makeTimer ||
    ((ms) => {
      let handle;
      const promise = new Promise((resolve) => {
        handle = setTimeout(() => resolve({ timedOut: true }), ms);
      });
      return { promise, cancel: () => clearTimeout(handle) };
    });

  /** Confirm the platform is fully stopped (delegated Lifecycle view). */
  async function verifyShutdown() {
    const lifecycle = platform.getKernel && platform.getKernel('lifecycle');
    if (!lifecycle || typeof lifecycle.health !== 'function') {
      return { ok: true, note: 'no lifecycle kernel to verify' };
    }
    try {
      const h = await lifecycle.health();
      const started = typeof h.started === 'number' ? h.started : 0;
      return { ok: started === 0, started };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * @param {object} [opts] { force=false, timeoutMs, verify=true }
   */
  async function shutdown(opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : defaultTimeoutMs;
    const force = opts.force === true;
    const start = clock();

    const graceful = Promise.resolve()
      .then(() => platform.shutdown())
      .then(() => ({ timedOut: false }));

    const timer = makeTimer(timeoutMs);
    const outcome = await Promise.race([graceful, timer.promise]);
    timer.cancel();

    let mode = 'graceful';
    if (outcome.timedOut) {
      if (!force) {
        log.error('shutdown exceeded timeout', { timeoutMs });
        throw new ShutdownError('shutdown exceeded timeout', { timeoutMs });
      }
      // Forced: proceed without awaiting the (stuck) graceful path.
      mode = 'forced';
      log.warn('shutdown forced after timeout', { timeoutMs });
    } else {
      // graceful settled — surface any underlying error
      await graceful;
    }

    const durationMs = clock() - start;
    const verification = opts.verify === false ? null : await verifyShutdown();
    if (verification && !verification.ok && !force) {
      throw new ShutdownError('shutdown verification failed', { verification });
    }
    return { ok: true, mode, durationMs, verification };
  }

  return { shutdown, verifyShutdown, defaultTimeoutMs };
}

module.exports = { createShutdownManager };
