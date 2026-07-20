'use strict';

/**
 * Sensitive-value redaction (Phase 14.3.2 §9) — PURE domain.
 *
 * The Configuration Platform must never surface secrets in logs, snapshots, or
 * events. Secrets are the Secret Provider's job (a FUTURE phase, deliberately
 * NOT implemented here). This module only DETECTS likely-sensitive keys and
 * redacts their values for observability surfaces — it does not store, fetch, or
 * manage secrets.
 *
 * Detection is by key name against a conservative pattern set (passwords, tokens,
 * private keys, credentials, API secrets). Callers may extend the pattern list.
 */

const DEFAULT_PATTERNS = Object.freeze([
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
  /\bpwd\b/i,
  /auth/i,
  /session/i,
  /cookie/i,
  /\bkey\b/i,
]);

const REDACTED = '«redacted»';

function isSensitiveKey(key, patterns = DEFAULT_PATTERNS) {
  if (typeof key !== 'string') return false;
  return patterns.some((re) => re.test(key));
}

/** Return a copy of `values` with sensitive values replaced by the redaction token. */
function redact(values = {}, patterns = DEFAULT_PATTERNS) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = isSensitiveKey(k, patterns) ? REDACTED : v;
  }
  return out;
}

/** Redact a single (key, value) pair for a log/event line. */
function redactValue(key, value, patterns = DEFAULT_PATTERNS) {
  return isSensitiveKey(key, patterns) ? REDACTED : value;
}

module.exports = { DEFAULT_PATTERNS, REDACTED, isSensitiveKey, redact, redactValue };
