'use strict';

/**
 * RetryPolicy (Phase 15.3 / ADR-032 §2/§3) — PURE domain value object. Declares
 * how many attempts to make and the deterministic exponential backoff between
 * them. No side effects; the engine consults it with an injected clock.
 *
 * Fields: maxAttempts (>=1), backoffMs, factor (>=1), maxBackoffMs (0 = uncapped).
 */

const { JobValidationError } = require('./errors');

function createRetryPolicy(spec = {}) {
  const maxAttempts = spec.maxAttempts == null ? 1 : Number(spec.maxAttempts);
  const backoffMs = spec.backoffMs == null ? 0 : Number(spec.backoffMs);
  const factor = spec.factor == null ? 2 : Number(spec.factor);
  const maxBackoffMs = spec.maxBackoffMs == null ? 0 : Number(spec.maxBackoffMs);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new JobValidationError('retryPolicy: maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new JobValidationError('retryPolicy: backoffMs must be a non-negative number');
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new JobValidationError('retryPolicy: factor must be a number >= 1');
  }
  return Object.freeze({
    maxAttempts,
    backoffMs,
    factor,
    maxBackoffMs,
    /** Whether another attempt is allowed after `attempts` have been made. */
    shouldRetry(attempts) {
      return attempts < maxAttempts;
    },
    /** Deterministic delay (ms) before the retry that follows `attempts` attempts. */
    nextDelayMs(attempts) {
      if (!backoffMs) return 0;
      const raw = backoffMs * Math.pow(factor, Math.max(0, attempts - 1));
      return maxBackoffMs > 0 ? Math.min(raw, maxBackoffMs) : raw;
    },
    toModel() {
      return { maxAttempts, backoffMs, factor, maxBackoffMs };
    },
  });
}

function policyFromModel(model) {
  return createRetryPolicy(model || {});
}

module.exports = { createRetryPolicy, policyFromModel };
