'use strict';

/**
 * Lock error model (Phase 14.3.5) — PURE domain. Typed errors so callers can
 * branch on `err.name`/`instanceof` rather than string matching.
 */

class LockError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LockError';
    if (details) this.details = details;
  }
}

/** Another owner already holds a live lease on the lock. */
class LockConflictError extends LockError {
  constructor(message, details) {
    super(message, details);
    this.name = 'LockConflictError';
  }
}

/** The caller is not the current owner (renew/release by a non-holder). */
class OwnershipError extends LockError {
  constructor(message, details) {
    super(message, details);
    this.name = 'OwnershipError';
  }
}

class LeaseError extends LockError {
  constructor(message, details) {
    super(message, details);
    this.name = 'LeaseError';
  }
}

module.exports = { LockError, LockConflictError, OwnershipError, LeaseError };
