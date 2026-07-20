'use strict';

/**
 * Audit error model (Phase 14.7 / ADR-026) — PURE domain. Typed errors so callers
 * branch on `err.name`/`instanceof` rather than string matching.
 */

class AuditError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AuditError';
    if (details) this.details = details;
  }
}

class AuditValidationError extends AuditError {
  constructor(message, details) {
    super(message, details);
    this.name = 'AuditValidationError';
  }
}

/** A record's checksum or the chain linkage failed verification (tampering). */
class AuditIntegrityError extends AuditError {
  constructor(message, details) {
    super(message, details);
    this.name = 'AuditIntegrityError';
  }
}

module.exports = { AuditError, AuditValidationError, AuditIntegrityError };
