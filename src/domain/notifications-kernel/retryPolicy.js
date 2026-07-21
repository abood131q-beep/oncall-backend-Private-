'use strict';

/**
 * RetryPolicy (Phase 15.1 / ADR-030 §2/§3) — PURE domain value object. Declares
 * how many delivery attempts to make and the deterministic exponential backoff
 * between them. No side effects; the engine consults it with an injected clock.
 *
 * Fields:
 *   maxAttempts — total delivery attempts (>= 1). 1 = no retry.
 *   backoffMs   — base delay before the first retry.
 *   factor      — exponential multiplier per subsequent retry.
 *   maxBackoffMs— cap on any single computed delay (0 = uncapped).
 */

const { NotificationValidationError } = require('./errors');

function createRetryPolicy(spec = {}) {
  const maxAttempts = spec.maxAttempts == null ? 1 : Number(spec.maxAttempts);
  const backoffMs = spec.backoffMs == null ? 0 : Number(spec.backoffMs);
  const factor = spec.factor == null ? 2 : Number(spec.factor);
  const maxBackoffMs = spec.maxBackoffMs == null ? 0 : Number(spec.maxBackoffMs);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new NotificationValidationError('retryPolicy: maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new NotificationValidationError('retryPolicy: backoffMs must be a non-negative number');
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new NotificationValidationError('retryPolicy: factor must be a number >= 1');
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
