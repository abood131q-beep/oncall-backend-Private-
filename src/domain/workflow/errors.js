'use strict';

/**
 * Workflow error model (Phase 14.4 / ADR-023) — PURE domain. Typed errors so
 * callers branch on `err.name`/`instanceof` rather than string matching.
 */

class WorkflowError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'WorkflowError';
    if (details) this.details = details;
  }
}

/** The workflow definition itself is malformed (bad states/transitions). */
class DefinitionError extends WorkflowError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DefinitionError';
  }
}

/** No transition exists for (currentState, event). */
class TransitionError extends WorkflowError {
  constructor(message, details) {
    super(message, details);
    this.name = 'TransitionError';
  }
}

/** A transition guard rejected the event. */
class GuardRejectedError extends WorkflowError {
  constructor(message, details) {
    super(message, details);
    this.name = 'GuardRejectedError';
  }
}

/** The workflow is not in a state that permits the requested operation. */
class InvalidStateError extends WorkflowError {
  constructor(message, details) {
    super(message, details);
    this.name = 'InvalidStateError';
  }
}

class WorkflowNotFoundError extends WorkflowError {
  constructor(message, details) {
    super(message, details);
    this.name = 'WorkflowNotFoundError';
  }
}

module.exports = {
  WorkflowError,
  DefinitionError,
  TransitionError,
  GuardRejectedError,
  InvalidStateError,
  WorkflowNotFoundError,
};
