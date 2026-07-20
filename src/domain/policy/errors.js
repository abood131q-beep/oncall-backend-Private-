'use strict';

/**
 * Policy error model (Phase 14.6 / ADR-025) — PURE domain. Typed errors so
 * callers branch on `err.name`/`instanceof` rather than string matching.
 */

class PolicyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PolicyError';
    if (details) this.details = details;
  }
}

/** A policy definition is malformed (bad effect, condition, scope, …). */
class PolicyDefinitionError extends PolicyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PolicyDefinitionError';
  }
}

/** A condition expression referenced an unknown operator or shape. */
class ConditionError extends PolicyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ConditionError';
  }
}

module.exports = { PolicyError, PolicyDefinitionError, ConditionError };
