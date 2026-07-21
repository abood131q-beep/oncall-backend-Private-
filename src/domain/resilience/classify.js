'use strict';

/**
 * Failure classification (Phase 15.7 / ADR-036 §3) — PURE domain, deterministic.
 * Maps a thrown error into a resilience outcome: its type and whether it is
 * retriable. An error is non-retriable when it explicitly declares `retriable ===
 * false` or its name is in the non-retriable set (validation / auth / not-found —
 * retrying those is pointless). Timeouts and generic errors are retriable.
 */

const NON_RETRIABLE = new Set([
  'ResilienceValidationError',
  'ValidationError',
  'CircuitOpenError',
  'BulkheadFullError',
  'AuthenticationError',
  'PermissionError',
  'NotFoundError',
]);

function classify(err) {
  if (!err) return { type: 'error', retriable: true };
  if (err.name === 'ExecutionTimeoutError') return { type: 'timeout', retriable: true };
  if (err.retriable === false) return { type: 'non_retriable', retriable: false };
  if (NON_RETRIABLE.has(err.name)) return { type: 'non_retriable', retriable: false };
  return { type: 'error', retriable: true };
}

module.exports = { classify, NON_RETRIABLE };
