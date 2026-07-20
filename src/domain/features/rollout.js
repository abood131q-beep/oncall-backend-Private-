'use strict';

/**
 * Percentage rollout (Phase 15.0 / ADR-029 §3) — PURE domain, deterministic
 * hashing. A stable bucketing key maps to a fixed bucket in [0, 10000) (basis
 * points), so the SAME key + SAME percentage always yields the SAME include
 * decision — no randomness, no clock. Ramping the percentage up only ever ADDS
 * keys to the included set (monotonic), never reshuffles them.
 */

const { checksum } = require('../extensions/integrity');

const RESOLUTION = 10000; // basis points → two decimal places of precision

/** Deterministic bucket in [0, 10000) for a stable key string. */
function bucketOf(key) {
  const hex = checksum(String(key)).slice(0, 8); // first 32 bits of sha256
  return parseInt(hex, 16) % RESOLUTION;
}

/**
 * Whether `key` is included at `percentage` (0..100). 0 → nobody, 100 → everybody.
 * Comparison is `< percentage*100` so ramps are monotonic and 100 is inclusive.
 */
function isIncluded(key, percentage) {
  const p = Number(percentage);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 100) return true;
  return bucketOf(key) < Math.round(p * (RESOLUTION / 100));
}

/** Build the canonical bucketing key: flag + salt + the stable subject id. */
function bucketingKey(flagName, salt, subjectId) {
  return `${flagName}:${salt || ''}:${subjectId}`;
}

module.exports = { bucketOf, isIncluded, bucketingKey, RESOLUTION };
