'use strict';

/**
 * Health status + aggregation (Phase 15.4 / ADR-033 §3) — PURE domain,
 * deterministic. Defines the health lattice and a worst-of aggregation used to
 * roll many component statuses into one. No I/O, no clock.
 */

const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

// Severity order: higher wins in aggregation.
const SEVERITY = Object.freeze({
  [HEALTH.HEALTHY]: 1,
  [HEALTH.UNKNOWN]: 2,
  [HEALTH.DEGRADED]: 3,
  [HEALTH.FAILED]: 4,
});

function normalize(status) {
  return Object.prototype.hasOwnProperty.call(SEVERITY, status) ? status : HEALTH.UNKNOWN;
}

/**
 * Aggregate many statuses into one (worst-of). Empty → unknown. A single FAILED
 * makes the whole set FAILED; a DEGRADED (with no FAILED) makes it DEGRADED; all
 * HEALTHY → HEALTHY; otherwise UNKNOWN.
 */
function aggregate(statuses = []) {
  if (!statuses.length) return HEALTH.UNKNOWN;
  let worst = HEALTH.HEALTHY;
  for (const s of statuses) {
    const n = normalize(s);
    if (SEVERITY[n] > SEVERITY[worst]) worst = n;
  }
  return worst;
}

module.exports = { HEALTH, SEVERITY, normalize, aggregate };
