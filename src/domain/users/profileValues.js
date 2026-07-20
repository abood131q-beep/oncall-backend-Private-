'use strict';

/**
 * Users domain — Profile Value Objects + Locale Value Object (ADR-002 §7).
 *
 * Pure: no I/O, no framework, no persistence (ADR-005 §18 dependency rules).
 *
 * STRANGLER FIDELITY NOTE: `DisplayName.tryCreate` intentionally mirrors the
 * legacy leniency of src/routes/users.js#/user/update, which passes `name`
 * straight to `UPDATE users SET name = ?` with no validation (global
 * sanitizeBody middleware is the only filter). Tightening this rule would be a
 * behavior change and MUST wait for legacy retirement under an ADR amendment —
 * not an edit here. The VO therefore accepts what the legacy path accepts and
 * only carries the concept + normalization the aggregate needs.
 */

/**
 * DisplayName — the passenger's chosen name (Profile Value Object).
 * Legacy accepts any value including undefined (→ SQL NULL). We preserve that
 * exactly: an absent name is represented as `undefined` and passed through.
 *
 * @param {unknown} raw
 * @returns {{ present: boolean, value: string | undefined }}
 */
function displayName(raw) {
  if (raw === undefined || raw === null) return { present: false, value: undefined };
  return { present: true, value: String(raw) };
}

// ── Locale Value Object (ADR-003 globalization) ──────────────────────────────
// DOMAIN-MODELED, NOT YET WIRED: no legacy endpoint reads/writes locale and the
// `users` table has no locale column, so exposing it would be a new feature
// (forbidden this phase). Built per the Phase-3 Domain Requirements as the
// vocabulary the User aggregate will adopt in Phase 4, once ADR-004 adds the
// column and an endpoint is introduced. Pure and side-effect free.

const SUPPORTED_LOCALES = Object.freeze(['ar', 'en']);
const DEFAULT_LOCALE = 'ar'; // platform default (Kuwait market, ADR-003)

/**
 * Locale — a validated BCP-47 primary subtag constrained to supported values.
 * @param {unknown} raw
 * @returns {{ valid: true, value: string } | { valid: false }}
 */
function tryCreateLocale(raw) {
  if (!raw) return { valid: false };
  const tag = String(raw).trim().toLowerCase().split('-')[0];
  return SUPPORTED_LOCALES.includes(tag) ? { valid: true, value: tag } : { valid: false };
}

module.exports = {
  displayName,
  tryCreateLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
};
