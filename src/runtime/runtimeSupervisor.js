'use strict';

/**
 * Runtime Supervisor (Phase 16.2 / ADR-043 §5) — supervises the bootstrapped runtime. It
 * tracks the platform lifecycle STATE, samples kernel health, records unexpected
 * failures, and exposes readiness / shutdown / restart state. It contains NO business
 * logic and never touches kernel internals — it only observes and records.
 */

const STATES = Object.freeze({
  CREATED: 'created',
  VERIFYING: 'verifying',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',
  SHUTTING_DOWN: 'shutting-down',
  STOPPED: 'stopped',
  RESTARTING: 'restarting',
  FAILED: 'failed',
});

function createRuntimeSupervisor(deps = {}) {
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };
  const failureLimit = deps.failureLimit || 100;

  let state = STATES.CREATED;
  const history = []; // { from, to, at }
  const failures = []; // { at, phase, message }
  let restarts = 0;

  function transition(to) {
    if (!Object.values(STATES).includes(to)) {
      throw new Error(`runtimeSupervisor: unknown state "${to}"`);
    }
    const from = state;
    state = to;
    history.push({ from, to, at: clock() });
    if (history.length > 500) history.shift();
    log.info('runtime state', { from, to });
    return to;
  }

  function recordFailure(phase, err) {
    failures.push({
      at: clock(),
      phase,
      message: err && err.message ? err.message : String(err),
    });
    if (failures.length > failureLimit) failures.shift();
    return failures[failures.length - 1];
  }

  function noteRestart() {
    restarts += 1;
    return restarts;
  }

  /** Sample platform health and derive readiness/liveness (no side effects on kernels). */
  async function sampleHealth(platform) {
    let health = null;
    try {
      health = await platform.health();
    } catch (e) {
      recordFailure('health', e);
      return { ok: false, error: e.message, ready: false, live: false };
    }
    const ready = state === STATES.READY && health.overall === true;
    // Liveness: the runtime process is responsive and not in a terminal failed state.
    const live = state !== STATES.FAILED && state !== STATES.STOPPED;
    if (state === STATES.READY && health.overall === false) {
      transition(STATES.DEGRADED);
    } else if (state === STATES.DEGRADED && health.overall === true) {
      transition(STATES.READY);
    }
    return { ok: health.overall, health, ready, live };
  }

  function snapshot() {
    return {
      state,
      ready: state === STATES.READY,
      shuttingDown: state === STATES.SHUTTING_DOWN,
      stopped: state === STATES.STOPPED,
      restarting: state === STATES.RESTARTING,
      failed: state === STATES.FAILED,
      restarts,
      failures: failures.slice(-10),
      transitions: history.length,
    };
  }

  return {
    STATES,
    state: () => state,
    transition,
    recordFailure,
    noteRestart,
    sampleHealth,
    snapshot,
    isReady: () => state === STATES.READY,
    isLive: () => state !== STATES.FAILED && state !== STATES.STOPPED,
  };
}

module.exports = { createRuntimeSupervisor, STATES };
