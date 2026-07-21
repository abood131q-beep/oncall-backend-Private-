'use strict';

/**
 * Deployment Supervisor (Phase 16.4 / ADR-045 §6) — monitors deployment state,
 * verification state, rollback state, the active release strategy, deployment duration,
 * and failure count. It contains NO business logic — it only observes and records.
 */

const STATES = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  DEPLOYING: 'deploying',
  VERIFYING: 'verifying',
  DEPLOYED: 'deployed',
  ROLLING_BACK: 'rolling-back',
  ROLLED_BACK: 'rolled-back',
  FAILED: 'failed',
});

function createDeploymentSupervisor(deps = {}) {
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };
  const failureLimit = deps.failureLimit || 200;

  let state = STATES.IDLE;
  let strategy = null;
  let verificationState = null; // null | 'passed' | 'failed'
  let rollbackState = null; // null | 'rolled-back' | 'failed'
  let lastDurationMs = null;
  const history = [];
  const failures = [];

  function transition(to) {
    if (!Object.values(STATES).includes(to)) {
      throw new Error(`deploymentSupervisor: unknown state "${to}"`);
    }
    const from = state;
    state = to;
    history.push({ from, to, at: clock() });
    if (history.length > 500) history.shift();
    if (to === STATES.ROLLED_BACK) rollbackState = 'rolled-back';
    log.info('deployment state', { from, to });
    return to;
  }

  function setStrategy(name) {
    strategy = name;
    return name;
  }
  function setVerification(ok) {
    verificationState = ok ? 'passed' : 'failed';
    return verificationState;
  }
  function setDuration(ms) {
    lastDurationMs = ms;
    return ms;
  }
  function recordFailure(phase, err, service) {
    failures.push({
      at: clock(),
      phase, // 'plan' | 'deploy' | 'verify' | 'rollback'
      service: service || null,
      message: err && err.message ? err.message : String(err),
    });
    if (failures.length > failureLimit) failures.shift();
    return failures[failures.length - 1];
  }

  function snapshot() {
    return {
      state,
      strategy,
      verificationState,
      rollbackState,
      deploymentDurationMs: lastDurationMs,
      failureCount: failures.length,
      failures: failures.slice(-10),
      transitions: history.length,
      deployed: state === STATES.DEPLOYED,
      failed: state === STATES.FAILED,
      rollingBack: state === STATES.ROLLING_BACK,
    };
  }

  return {
    STATES,
    state: () => state,
    transition,
    setStrategy,
    setVerification,
    setDuration,
    recordFailure,
    snapshot,
    rollbackReady: () => state === STATES.DEPLOYED || state === STATES.FAILED,
  };
}

module.exports = { createDeploymentSupervisor, STATES };
