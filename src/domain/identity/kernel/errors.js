'use strict';

/**
 * errors.js — Consolidated Identity Kernel (Phase 19.4 skeleton, ADR-049).
 *
 * Pure domain error types for the consolidated Identity Kernel. No I/O, no framework.
 *
 * SKELETON PHASE: the kernel structure exists but owns NO behavior yet. Any skeleton method that
 * would perform real work throws `IdentityKernelNotWired` so accidental production use is impossible
 * — the legacy path (middleware/auth.js, otpService, token gateway, identity repository) remains the
 * sole authoritative implementation until a later, explicitly-chartered migration phase.
 */

class IdentityKernelError extends Error {
  constructor(message, code = 'IDENTITY_KERNEL_ERROR') {
    super(message);
    this.name = 'IdentityKernelError';
    this.code = code;
  }
}

/** Thrown by skeleton implementations that are structurally present but not yet wired. */
class IdentityKernelNotWired extends IdentityKernelError {
  constructor(what = 'operation') {
    super(
      `Identity Kernel is a skeleton (Phase 19.4): "${what}" is not wired. ` +
        'The legacy identity path remains authoritative (ADR-049 §6).',
      'IDENTITY_KERNEL_NOT_WIRED'
    );
    this.name = 'IdentityKernelNotWired';
  }
}

/** Thrown when a required outbound port is missing/invalid at composition time. */
class IdentityPortError extends IdentityKernelError {
  constructor(message) {
    super(message, 'IDENTITY_PORT_ERROR');
    this.name = 'IdentityPortError';
  }
}

module.exports = { IdentityKernelError, IdentityKernelNotWired, IdentityPortError };
