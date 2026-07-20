'use strict';

/**
 * Identity Kernel error model (Phase 14.8 / ADR-027) — PURE domain. Typed errors
 * so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class IdentityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'IdentityError';
    if (details) this.details = details;
  }
}

class IdentityValidationError extends IdentityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IdentityValidationError';
  }
}

/** Credentials did not verify (wrong secret / unknown principal). */
class AuthenticationError extends IdentityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'AuthenticationError';
  }
}

/** Session missing, expired, revoked, or token mismatch. */
class SessionError extends IdentityError {
  constructor(message, details) {
    super(message, details);
    this.name = 'SessionError';
  }
}

module.exports = { IdentityError, IdentityValidationError, AuthenticationError, SessionError };
