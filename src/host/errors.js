'use strict';

/**
 * Enterprise Host Runtime — error model (Phase 16.3 / ADR-044).
 *
 * Typed errors so operators + callers branch on `err.name`/`instanceof`. The Host is a
 * thin orchestration layer ABOVE the Bootstrap Runtime (ADR-043); these errors describe
 * HOSTING faults only (service contracts, registry, service dependency graph, hosted
 * lifecycle). Runtime faults surface as ADR-043's RuntimeError family; composition faults
 * as ADR-042's PlatformError family; kernel faults as the kernels' own typed errors.
 */

class HostError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'HostError';
    if (details) this.details = details;
  }
}

/** Invalid host options / usage in a state that does not permit the operation. */
class HostStateError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'HostStateError';
  }
}

/** A hosted service does not satisfy the service contract (§2). */
class ServiceContractError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ServiceContractError';
  }
}

/** A service id was registered twice. */
class DuplicateServiceError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DuplicateServiceError';
  }
}

/** A requested service could not be resolved / a declared dependency is missing. */
class ServiceNotFoundError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ServiceNotFoundError';
  }
}

/** The hosted-service dependency graph is invalid (missing/duplicate/circular). */
class ServiceDependencyError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ServiceDependencyError';
  }
}

/** A hosted service failed to start or stop. */
class ServiceLifecycleError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ServiceLifecycleError';
  }
}

/** Host-level verification failed. */
class HostVerificationError extends HostError {
  constructor(message, details) {
    super(message, details);
    this.name = 'HostVerificationError';
  }
}

module.exports = {
  HostError,
  HostStateError,
  ServiceContractError,
  DuplicateServiceError,
  ServiceNotFoundError,
  ServiceDependencyError,
  ServiceLifecycleError,
  HostVerificationError,
};
