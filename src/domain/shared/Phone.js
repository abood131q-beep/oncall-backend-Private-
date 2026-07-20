'use strict';

/**
 * Phone — value object (ADR-002 §7, ADR-004 §3).
 *
 * Canonical phone validation for the Domain layer. The rule intentionally
 * mirrors src/utils/helpers.js#validatePhone (the legacy path) so that both
 * paths accept exactly the same inputs during the strangler migration.
 * When the legacy path is retired, this file becomes the single source.
 *
 * Pure: no dependencies, no side effects (Domain layer rule, ADR-005 §18).
 */

const PHONE_PATTERN = /^[0-9+\-\s]+$/;
const HAS_DIGIT = /[0-9]/;

/**
 * @param {unknown} raw
 * @returns {{ valid: true, value: string } | { valid: false }}
 */
function tryCreatePhone(raw) {
  if (!raw) return { valid: false };
  const p = String(raw).trim();
  const valid = p.length >= 3 && p.length <= 20 && PHONE_PATTERN.test(p) && HAS_DIGIT.test(p);
  return valid ? { valid: true, value: p } : { valid: false };
}

/** Mask a phone for logs — never log full identifiers (ADR-007 posture). */
function maskPhone(phone) {
  return String(phone).slice(0, 3) + '***';
}

module.exports = { tryCreatePhone, maskPhone };
