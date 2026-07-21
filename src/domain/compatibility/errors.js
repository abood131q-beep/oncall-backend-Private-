'use strict';

/**
 * Compatibility Kernel error model (Phase 15.12 / ADR-041) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class CompatibilityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CompatibilityError';
    if (details) this.details = details;
  }
}

class CompatibilityValidationError extends CompatibilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CompatibilityValidationError';
  }
}

/** Requested contract does not exist in the namespace. */
class ContractNotFoundError extends CompatibilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ContractNotFoundError';
  }
}

/** Capability negotiation could not reach an agreement. */
class NegotiationError extends CompatibilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'NegotiationError';
  }
}

/** A stored contract does not match its checksum (tamper/corruption). */
class IntegrityError extends CompatibilityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  CompatibilityError,
  CompatibilityValidationError,
  ContractNotFoundError,
  NegotiationError,
  IntegrityError,
};
