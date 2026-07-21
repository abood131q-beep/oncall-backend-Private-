'use strict';

/**
 * Resilience Kernel error model (Phase 15.7 / ADR-036) — PURE domain. Typed errors
 * so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class ResilienceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ResilienceError';
    if (details) this.details = details;
  }
}

class ResilienceValidationError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ResilienceValidationError';
  }
}

/** Requested policy does not exist in the namespace. */
class PolicyNotFoundError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PolicyNotFoundError';
  }
}

/** The circuit is open — execution is short-circuited. */
class CircuitOpenError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CircuitOpenError';
    this.retriable = false;
  }
}

/** The bulkhead is saturated — no concurrency slot available. */
class BulkheadFullError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'BulkheadFullError';
    this.retriable = false;
  }
}

/** The protected execution exceeded its timeout budget. */
class ExecutionTimeoutError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ExecutionTimeoutError';
    this.retriable = true;
  }
}

/** A stored policy does not match its checksum (tamper/corruption). */
class IntegrityError extends ResilienceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  ResilienceError,
  ResilienceValidationError,
  PolicyNotFoundError,
  CircuitOpenError,
  BulkheadFullError,
  ExecutionTimeoutError,
  IntegrityError,
};
