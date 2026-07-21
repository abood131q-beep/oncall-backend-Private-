'use strict';

/**
 * Service Discovery Kernel error model (Phase 15.5 / ADR-034) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class DiscoveryError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DiscoveryError';
    if (details) this.details = details;
  }
}

class DiscoveryValidationError extends DiscoveryError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DiscoveryValidationError';
  }
}

/** No service instance matched the query / resolution. */
class ServiceNotFoundError extends DiscoveryError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ServiceNotFoundError';
  }
}

/** A stored service does not match its checksum (tamper/corruption). */
class IntegrityError extends DiscoveryError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = { DiscoveryError, DiscoveryValidationError, ServiceNotFoundError, IntegrityError };
