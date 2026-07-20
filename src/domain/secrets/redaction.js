'use strict';

/**
 * Secure redaction (Phase 14.9 / ADR-028 §3/§9) — PURE domain. The single place
 * that decides how a protected value is masked for any non-authoritative view
 * (events, listings, logs, diagnostics, SDK errors). A redacted value NEVER
 * reveals the plaintext; the full value is only ever returned by an explicit
 * `resolve()` on the engine.
 */

const REDACTED = '***REDACTED***';

/** Mask a raw value. Always returns the constant token — no length/content leak. */
function redactValue(value) {
  return value == null ? null : REDACTED;
}

/**
 * Return a copy of a secret model with the value masked. Keeps the integrity
 * fingerprint (valueChecksum) — it is a one-way hash and reveals nothing.
 */
function redactModel(model) {
  if (!model) return model;
  const copy = { ...model };
  if ('value' in copy) copy.value = redactValue(copy.value);
  return copy;
}

module.exports = { REDACTED, redactValue, redactModel };
