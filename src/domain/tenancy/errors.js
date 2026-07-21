'use strict';

/**
 * Multi-Tenancy Kernel error model (Phase 15.9 / ADR-038) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class TenancyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TenancyError';
    if (details) this.details = details;
  }
}

class TenancyValidationError extends TenancyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'TenancyValidationError';
  }
}

/** Requested tenant does not exist in the namespace. */
class TenantNotFoundError extends TenancyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'TenantNotFoundError';
  }
}

/** A caller scoped to one tenant attempted to access another (isolation breach). */
class CrossTenantError extends TenancyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CrossTenantError';
  }
}

/** A stored tenant does not match its checksum (tamper/corruption). */
class IntegrityError extends TenancyError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  TenancyError,
  TenancyValidationError,
  TenantNotFoundError,
  CrossTenantError,
  IntegrityError,
};
