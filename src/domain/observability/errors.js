'use strict';

/**
 * Observability Kernel error model (Phase 15.4 / ADR-033) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class ObservabilityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ObservabilityError';
    if (details) this.details = details;
  }
}

class ObservabilityValidationError extends ObservabilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ObservabilityValidationError';
  }
}

/** Requested component does not exist in the namespace. */
class ComponentNotFoundError extends ObservabilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ComponentNotFoundError';
  }
}

/** A stored component/snapshot does not match its checksum (tamper/corruption). */
class IntegrityError extends ObservabilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  ObservabilityError,
  ObservabilityValidationError,
  ComponentNotFoundError,
  IntegrityError,
};
