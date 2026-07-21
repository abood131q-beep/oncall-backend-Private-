'use strict';

/**
 * Enterprise Platform Composition Root — error model (Phase 16.1 / ADR-042).
 *
 * Typed errors so callers branch on `err.name`/`instanceof` rather than string
 * matching. This layer composes Kernels; it never modifies them, so these errors
 * describe COMPOSITION faults (registration, dependency graph, resolution,
 * verification) — never kernel-internal faults, which surface as the kernels' own
 * typed errors.
 */

class PlatformError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PlatformError';
    if (details) this.details = details;
  }
}

/** Invalid composition options / descriptors. */
class PlatformValidationError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PlatformValidationError';
  }
}

/** A kernel was registered twice under the same name. */
class DuplicateKernelError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DuplicateKernelError';
  }
}

/** A kernel declared a dependency that was never registered. */
class MissingDependencyError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'MissingDependencyError';
  }
}

/** The dependency graph contains a cycle. */
class DependencyCycleError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DependencyCycleError';
  }
}

/** A requested kernel could not be resolved from the registry. */
class KernelResolutionError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'KernelResolutionError';
  }
}

/** A kernel factory failed or returned an unusable service during composition. */
class CompositionError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CompositionError';
  }
}

/** Platform-wide verification failed (graph, ports, providers, or compatibility). */
class PlatformVerificationError extends PlatformError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PlatformVerificationError';
  }
}

module.exports = {
  PlatformError,
  PlatformValidationError,
  DuplicateKernelError,
  MissingDependencyError,
  DependencyCycleError,
  KernelResolutionError,
  CompositionError,
  PlatformVerificationError,
};
