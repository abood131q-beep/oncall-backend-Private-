'use strict';

/**
 * Enterprise Bootstrap Runtime — error model (Phase 16.2 / ADR-043).
 *
 * Typed errors so operators + callers branch on `err.name`/`instanceof`. The runtime is a
 * thin layer ABOVE the Composition Root (ADR-042); these errors describe BOOTSTRAP and
 * SUPERVISION faults only. Composition faults surface as ADR-042's PlatformError family;
 * kernel-internal faults surface as the kernels' own typed errors.
 */

class RuntimeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RuntimeError';
    if (details) this.details = details;
  }
}

/** Startup verification failed before platform.start() — bootstrap must abort. */
class StartupVerificationError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'StartupVerificationError';
  }
}

/** Bootstrap could not bring the platform to a ready state. */
class BootstrapError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'BootstrapError';
  }
}

/** A shutdown did not complete cleanly (timeout / forced / verification). */
class ShutdownError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ShutdownError';
  }
}

/** A restart could not complete (verify → shutdown → rebuild → start → verify). */
class RestartError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RestartError';
  }
}

/** The runtime was used in a state that does not permit the operation. */
class RuntimeStateError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RuntimeStateError';
  }
}

/** Runtime-level verification (verify()) failed. */
class RuntimeVerificationError extends RuntimeError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RuntimeVerificationError';
  }
}

module.exports = {
  RuntimeError,
  StartupVerificationError,
  BootstrapError,
  ShutdownError,
  RestartError,
  RuntimeStateError,
  RuntimeVerificationError,
};
