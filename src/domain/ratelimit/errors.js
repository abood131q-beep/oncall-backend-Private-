'use strict';

/**
 * Rate Limiting Kernel error model (Phase 15.2 / ADR-031) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class RateLimitError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RateLimitError';
    if (details) this.details = details;
  }
}

class RateLimitValidationError extends RateLimitError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RateLimitValidationError';
  }
}

/** Requested policy does not exist / no policy matches the subject. */
class PolicyNotFoundError extends RateLimitError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PolicyNotFoundError';
  }
}

/** A stored policy does not match its checksum (tamper/corruption). */
class IntegrityError extends RateLimitError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = { RateLimitError, RateLimitValidationError, PolicyNotFoundError, IntegrityError };
