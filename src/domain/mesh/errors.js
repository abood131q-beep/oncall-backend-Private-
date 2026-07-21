'use strict';

/**
 * Service Mesh Kernel error model (Phase 15.8 / ADR-037) — PURE domain. Typed errors
 * so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class MeshError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MeshError';
    if (details) this.details = details;
  }
}

class MeshValidationError extends MeshError {
  constructor(message, details) {
    super(message, details);
    this.name = 'MeshValidationError';
  }
}

/** Requested connection does not exist in the namespace. */
class ConnectionNotFoundError extends MeshError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ConnectionNotFoundError';
  }
}

/** An invocation was rejected by mesh policy (security/traffic/not-connected). */
class MeshRejectedError extends MeshError {
  constructor(message, reason, details) {
    super(message, details);
    this.name = 'MeshRejectedError';
    this.reason = reason || 'rejected';
  }
}

/** A stored connection does not match its checksum (tamper/corruption). */
class IntegrityError extends MeshError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  MeshError,
  MeshValidationError,
  ConnectionNotFoundError,
  MeshRejectedError,
  IntegrityError,
};
