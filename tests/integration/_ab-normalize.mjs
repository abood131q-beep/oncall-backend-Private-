'use strict';

/**
 * _ab-normalize.mjs — shared A/B response normalizer.
 *
 * The A/B harnesses compare a legacy server vs an enterprise/shadow server for BYTE-IDENTICAL
 * responses on the public contract. A few observability endpoints legitimately carry
 * process/wall-clock-variable telemetry that differs between two separately-booted processes even
 * when the code is identical:
 *   • /health, /health/live, /health/ready → `uptime` (seconds) and `timestamp` (ISO, ms precision)
 *   • /metrics                              → live gauge VALUES (uptime, heap, rss, cpu, RT quantiles)
 *
 * These fields are NOT part of the behavioral contract; comparing them byte-for-byte makes the
 * harness fail on wall-clock noise, never on real drift. This normalizer masks ONLY those provably
 * volatile fields, so structural/contract drift (missing metric, changed status, different db check,
 * renamed field) is still caught in full. It does not weaken the gate — it removes false positives.
 *
 * NOTE: filename does not end in `-ab.mjs`, so scripts/run-ab.mjs will not execute it as a harness.
 */

/** /metrics is Prometheus text; compare the metric SHAPE (HELP/TYPE lines), not the live values. */
export function metricNames(body) {
  return body
    .split('\n')
    .filter((l) => l.startsWith('# TYPE ') || l.startsWith('# HELP '))
    .sort()
    .join('\n');
}

/** /health* is JSON; mask the two volatile fields (uptime, timestamp), keep everything else. */
export function healthShape(body) {
  try {
    const o = JSON.parse(body);
    if ('uptime' in o) o.uptime = '<n>';
    if ('timestamp' in o) o.timestamp = '<ts>';
    return JSON.stringify(o);
  } catch {
    return body;
  }
}

/** Normalize a response body for the given path; non-volatile paths pass through untouched. */
export function normalizeBody(path, body) {
  if (path === '/metrics') return metricNames(body);
  if (path === '/health' || path === '/health/live' || path === '/health/ready')
    return healthShape(body);
  return body;
}
