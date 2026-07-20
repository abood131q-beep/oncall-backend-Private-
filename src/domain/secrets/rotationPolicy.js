'use strict';

/**
 * RotationPolicy (Phase 14.9 / ADR-028 §2/§3) — PURE domain value object. Declares
 * WHEN a secret should rotate and HOW MANY historical versions to retain. It holds
 * no side effects; the engine consults it deterministically with an injected clock.
 *
 * Fields:
 *   enabled     — whether automated rotation is expected (advisory; the engine
 *                 exposes `isDue`, it does not self-schedule).
 *   intervalMs  — minimum age before a secret is considered due for rotation.
 *   maxVersions — retained version count (0 / falsy = unbounded).
 */

const { SecretValidationError } = require('./errors');

function createRotationPolicy(spec = {}) {
  const enabled = Boolean(spec.enabled);
  const intervalMs = spec.intervalMs == null ? 0 : Number(spec.intervalMs);
  const maxVersions = spec.maxVersions == null ? 0 : Number(spec.maxVersions);
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new SecretValidationError('rotationPolicy: intervalMs must be a non-negative number');
  }
  if (!Number.isFinite(maxVersions) || maxVersions < 0) {
    throw new SecretValidationError('rotationPolicy: maxVersions must be a non-negative number');
  }
  return Object.freeze({
    enabled,
    intervalMs,
    maxVersions,
    /** Due when rotation is enabled, an interval is set, and enough time has passed. */
    isDue(updatedAt, now) {
      if (!enabled || !intervalMs) return false;
      return now - updatedAt >= intervalMs;
    },
    toModel() {
      return { enabled, intervalMs, maxVersions };
    },
  });
}

/** Rehydrate a policy from a persisted model (tolerant of null → defaults). */
function policyFromModel(model) {
  return createRotationPolicy(model || {});
}

module.exports = { createRotationPolicy, policyFromModel };
