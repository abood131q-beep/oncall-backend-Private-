'use strict';

/**
 * Resource Management Kernel error model (Phase 15.10 / ADR-039) — PURE domain.
 * Typed errors so callers branch on `err.name`/`instanceof` rather than string
 * matching.
 */

class ResourceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ResourceError';
    if (details) this.details = details;
  }
}

class ResourceValidationError extends ResourceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ResourceValidationError';
  }
}

/** Requested resource or allocation does not exist in the namespace. */
class ResourceNotFoundError extends ResourceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ResourceNotFoundError';
  }
}

/** An allocation would exceed the owner's quota. */
class QuotaExceededError extends ResourceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'QuotaExceededError';
  }
}

/** Insufficient capacity and no lower-priority allocation could be preempted. */
class ResourceConflictError extends ResourceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ResourceConflictError';
  }
}

/** A stored resource/allocation does not match its checksum (tamper/corruption). */
class IntegrityError extends ResourceError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  ResourceError,
  ResourceValidationError,
  ResourceNotFoundError,
  QuotaExceededError,
  ResourceConflictError,
  IntegrityError,
};
