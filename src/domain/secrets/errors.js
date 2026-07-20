'use strict';

/**
 * Secrets Kernel error model (Phase 14.9 / ADR-028) — PURE domain. Typed errors
 * so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class SecretError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SecretError';
    if (details) this.details = details;
  }
}

class SecretValidationError extends SecretError {
  constructor(message, details) {
    super(message, details);
    this.name = 'SecretValidationError';
  }
}

/** Requested secret (or version) does not exist / is deleted. */
class SecretNotFoundError extends SecretError {
  constructor(message, details) {
    super(message, details);
    this.name = 'SecretNotFoundError';
  }
}

/** Rotation was rejected (missing/duplicate value, deleted secret, policy). */
class RotationError extends SecretError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RotationError';
  }
}

/** Stored value does not match its integrity checksum (tamper/corruption). */
class IntegrityError extends SecretError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  SecretError,
  SecretValidationError,
  SecretNotFoundError,
  RotationError,
  IntegrityError,
};
