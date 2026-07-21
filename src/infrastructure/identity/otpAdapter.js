'use strict';

/**
 * otpAdapter.js — Consolidated Identity Kernel infrastructure (Phase 20.a, ADR-049 §5).
 *
 * Future owner of OTP send/verify currently in `src/services/otpService.js`. Implements the kernel's
 * `otpPort`. SHADOW-PHASE: thin pass-through to the injected legacy OTP primitives; inert
 * (`IdentityKernelNotWired`) when not wired. otpService remains authoritative.
 */

const { IdentityKernelNotWired } = require('../../domain/identity/kernel/errors');

function createIdentityOtpAdapter(deps = {}) {
  const passthrough = (fn, name) =>
    typeof fn === 'function'
      ? fn
      : () => {
          throw new IdentityKernelNotWired(`otpAdapter.${name}`);
        };

  return Object.freeze({
    // `isRequired` mirrors the legacy REQUIRE_OTP flag (pure).
    isRequired:
      typeof deps.requireOtp === 'function'
        ? deps.requireOtp
        : deps.requireOtp !== undefined
          ? () => Boolean(deps.requireOtp)
          : passthrough(undefined, 'isRequired'),
    send: passthrough(deps.sendOTP, 'send'),
    verify: passthrough(deps.verifyOTP, 'verify'),
  });
}

module.exports = { createIdentityOtpAdapter };
