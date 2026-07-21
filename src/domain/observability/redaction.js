'use strict';

/**
 * Diagnostic redaction (Phase 15.4 / ADR-033 §9) — PURE domain. The single place
 * that masks sensitive metadata before it appears in a diagnostic snapshot, an
 * event, or a log. A redacted value never reveals the plaintext. Deterministic.
 */

const REDACTED = '***REDACTED***';
const SENSITIVE =
  /(secret|token|password|passwd|credential|api[-_]?key|private[-_]?key|authorization)/i;

/** Return a copy of an object with sensitive keys masked (recursively). */
function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.test(k) ? REDACTED : redact(v);
  }
  return out;
}

module.exports = { REDACTED, SENSITIVE, redact };
