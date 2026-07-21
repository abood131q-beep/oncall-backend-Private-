'use strict';

/**
 * Lifecycle Management Kernel error model (Phase 15.11 / ADR-040) — PURE domain.
 * Typed errors so callers branch on `err.name`/`instanceof` rather than string
 * matching.
 */

class LifecycleError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LifecycleError';
    if (details) this.details = details;
  }
}

class LifecycleValidationError extends LifecycleError {
  constructor(message, details) {
    super(message, details);
    this.name = 'LifecycleValidationError';
  }
}

/** Requested component does not exist in the namespace. */
class ComponentNotFoundError extends LifecycleError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ComponentNotFoundError';
  }
}

/** The dependency graph is invalid (missing dependency or cycle). */
class DependencyError extends LifecycleError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DependencyError';
  }
}

/** An invalid lifecycle state transition was requested. */
class TransitionError extends LifecycleError {
  constructor(message, details) {
    super(message, details);
    this.name = 'TransitionError';
  }
}

/** A stored component does not match its checksum (tamper/corruption). */
class IntegrityError extends LifecycleError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  LifecycleError,
  LifecycleValidationError,
  ComponentNotFoundError,
  DependencyError,
  TransitionError,
  IntegrityError,
};
