'use strict';

/**
 * Circuit breaker state machine (Phase 15.7 / ADR-036 §3) — PURE domain,
 * deterministic. Transitions are functions of (state, policy, now); no clock, no
 * side effects. States:
 *   closed     — requests flow; failures accumulate toward failureThreshold.
 *   open       — requests are short-circuited until recoveryWindow elapses.
 *   half_open  — a trial window; successes toward successThreshold close it, any
 *                failure re-opens it.
 */

const CIRCUIT = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });

function initialState() {
  return { state: CIRCUIT.CLOSED, failures: 0, successes: 0, openedAt: null, updatedAt: 0 };
}

/**
 * Whether an attempt is allowed now. May transition open → half_open when the
 * recovery window has elapsed. Returns { allowed, state, transitioned }.
 */
function canAttempt(state, policy, now) {
  const s = { ...state };
  if (s.state === CIRCUIT.OPEN) {
    if (s.openedAt != null && now - s.openedAt >= policy.recoveryWindow) {
      return {
        allowed: true,
        transitioned: CIRCUIT.HALF_OPEN,
        state: { ...s, state: CIRCUIT.HALF_OPEN, successes: 0, updatedAt: now },
      };
    }
    return { allowed: false, transitioned: null, state: s };
  }
  return { allowed: true, transitioned: null, state: s };
}

/** Record a success. half_open → closed after successThreshold; closed resets failures. */
function onSuccess(state, policy, now) {
  const s = { ...state, updatedAt: now };
  if (s.state === CIRCUIT.HALF_OPEN) {
    s.successes += 1;
    if (s.successes >= policy.successThreshold) {
      return {
        state: { state: CIRCUIT.CLOSED, failures: 0, successes: 0, openedAt: null, updatedAt: now },
        transitioned: CIRCUIT.CLOSED,
      };
    }
    return { state: s, transitioned: null };
  }
  s.failures = 0;
  return { state: s, transitioned: null };
}

/** Record a failure. half_open → open; closed → open at failureThreshold. */
function onFailure(state, policy, now) {
  const s = { ...state, updatedAt: now };
  if (s.state === CIRCUIT.HALF_OPEN) {
    return {
      state: {
        state: CIRCUIT.OPEN,
        failures: s.failures + 1,
        successes: 0,
        openedAt: now,
        updatedAt: now,
      },
      transitioned: CIRCUIT.OPEN,
    };
  }
  if (s.state === CIRCUIT.CLOSED) {
    s.failures += 1;
    if (s.failures >= policy.failureThreshold) {
      return {
        state: {
          state: CIRCUIT.OPEN,
          failures: s.failures,
          successes: 0,
          openedAt: now,
          updatedAt: now,
        },
        transitioned: CIRCUIT.OPEN,
      };
    }
    return { state: s, transitioned: null };
  }
  return { state: s, transitioned: null };
}

module.exports = { CIRCUIT, initialState, canAttempt, onSuccess, onFailure };
