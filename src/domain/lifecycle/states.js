'use strict';

/**
 * Lifecycle state machine (Phase 15.11 / ADR-040 §3) — PURE domain, deterministic.
 * Defines the component states and the legal transitions between them. State
 * transition validation is a pure predicate; the engine consults it before every
 * transition and records a failed-transition metric on a violation.
 */

const STATE = Object.freeze({
  REGISTERED: 'registered',
  INITIALIZED: 'initialized',
  STARTED: 'started',
  SUSPENDED: 'suspended',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

// Legal transitions: from → allowed targets.
const TRANSITIONS = Object.freeze({
  [STATE.REGISTERED]: [STATE.INITIALIZED, STATE.FAILED],
  [STATE.INITIALIZED]: [STATE.STARTED, STATE.STOPPED, STATE.FAILED],
  [STATE.STARTED]: [STATE.SUSPENDED, STATE.STOPPED, STATE.FAILED],
  [STATE.SUSPENDED]: [STATE.STARTED, STATE.STOPPED, STATE.FAILED],
  [STATE.STOPPED]: [STATE.INITIALIZED, STATE.STARTED, STATE.FAILED],
  [STATE.FAILED]: [STATE.INITIALIZED, STATE.STARTED, STATE.STOPPED],
});

function validTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = { STATE, TRANSITIONS, validTransition };
