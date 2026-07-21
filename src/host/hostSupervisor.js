'use strict';

/**
 * Host Supervisor (Phase 16.3 / ADR-044 §6) — monitors the host. It tracks runtime state,
 * per-service state, startup/shutdown failures, restart count, and health degradation. It
 * contains NO business logic and never touches service or kernel internals — it only
 * observes and records.
 */

const STATES = Object.freeze({
  CREATED: 'created',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',
  SHUTTING_DOWN: 'shutting-down',
  STOPPED: 'stopped',
  RESTARTING: 'restarting',
  FAILED: 'failed',
});

const SERVICE_STATES = Object.freeze({
  REGISTERED: 'registered',
  STARTING: 'starting',
  STARTED: 'started',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

function createHostSupervisor(deps = {}) {
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };
  const failureLimit = deps.failureLimit || 200;

  let state = STATES.CREATED;
  const history = [];
  const failures = [];
  const serviceState = new Map(); // id -> service state
  let restarts = 0;

  function transition(to) {
    if (!Object.values(STATES).includes(to)) {
      throw new Error(`hostSupervisor: unknown state "${to}"`);
    }
    const from = state;
    state = to;
    history.push({ from, to, at: clock() });
    if (history.length > 500) history.shift();
    log.info('host state', { from, to });
    return to;
  }

  function setServiceState(id, s) {
    if (!Object.values(SERVICE_STATES).includes(s)) {
      throw new Error(`hostSupervisor: unknown service state "${s}"`);
    }
    serviceState.set(id, s);
    return s;
  }

  function recordFailure(phase, err, service) {
    failures.push({
      at: clock(),
      phase, // 'runtime' | 'startup' | 'shutdown' | 'restart' | 'health'
      service: service || null,
      message: err && err.message ? err.message : String(err),
    });
    if (failures.length > failureLimit) failures.shift();
    return failures[failures.length - 1];
  }

  function noteRestart() {
    restarts += 1;
    return restarts;
  }

  /** Fold overall host health from runtime + service health without side effects. */
  function assess({ runtimeOk, serviceHealth }) {
    const services = serviceHealth || {};
    const unhealthy = Object.entries(services)
      .filter(([, h]) => h && h.ok === false)
      .map(([id]) => id);
    const overall = Boolean(runtimeOk) && unhealthy.length === 0;
    if (state === STATES.READY && !overall) transition(STATES.DEGRADED);
    else if (state === STATES.DEGRADED && overall) transition(STATES.READY);
    return { overall, unhealthyServices: unhealthy };
  }

  function snapshot() {
    return {
      state,
      ready: state === STATES.READY,
      degraded: state === STATES.DEGRADED,
      shuttingDown: state === STATES.SHUTTING_DOWN,
      stopped: state === STATES.STOPPED,
      restarting: state === STATES.RESTARTING,
      failed: state === STATES.FAILED,
      restarts,
      services: Object.fromEntries(serviceState),
      failures: failures.slice(-10),
      transitions: history.length,
    };
  }

  return {
    STATES,
    SERVICE_STATES,
    state: () => state,
    transition,
    setServiceState,
    serviceStateOf: (id) => serviceState.get(id) || null,
    recordFailure,
    noteRestart,
    assess,
    snapshot,
    isReady: () => state === STATES.READY,
    isLive: () => state !== STATES.FAILED && state !== STATES.STOPPED,
  };
}

module.exports = { createHostSupervisor, STATES, SERVICE_STATES };
