'use strict';

/**
 * Background Jobs Kernel error model (Phase 15.3 / ADR-032) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class JobError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'JobError';
    if (details) this.details = details;
  }
}

class JobValidationError extends JobError {
  constructor(message, details) {
    super(message, details);
    this.name = 'JobValidationError';
  }
}

/** Requested job does not exist in the namespace. */
class JobNotFoundError extends JobError {
  constructor(message, details) {
    super(message, details);
    this.name = 'JobNotFoundError';
  }
}

/** No handler registered for the job type. */
class HandlerError extends JobError {
  constructor(message, details) {
    super(message, details);
    this.name = 'HandlerError';
  }
}

/** A stored job does not match its checksum (tamper/corruption). */
class IntegrityError extends JobError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = { JobError, JobValidationError, JobNotFoundError, HandlerError, IntegrityError };
