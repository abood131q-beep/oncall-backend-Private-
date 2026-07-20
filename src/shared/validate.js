'use strict';

/**
 * validate.js — Dependency-free schema validation (Phase 12: C7).
 *
 * ADDITIVE, OPT-IN. A tiny, zero-dependency validator so NEW endpoints (and,
 * later, hardened existing ones) can declare their input contract explicitly
 * instead of ad-hoc `if` checks. It is NOT retrofitted onto the frozen public
 * endpoints in this phase (that would risk changing a response), so existing
 * A/B contracts are unaffected. Returns a typed result; the caller maps it to
 * HTTP — keeping validation out of the transport layer's decisions.
 *
 * Supported field rules: { type, required, min, max, minLength, maxLength,
 * pattern, enum }. Types: 'string' | 'number' | 'boolean' | 'phone'.
 */

const PHONE_RE = /^[0-9]{6,15}$/;

function validate(input, schema) {
  const data = input && typeof input === 'object' ? input : {};
  const errors = [];
  const value = {};

  for (const [field, rule] of Object.entries(schema)) {
    let v = data[field];

    if (v === undefined || v === null || v === '') {
      if (rule.required) errors.push({ field, code: 'REQUIRED' });
      continue;
    }

    if (rule.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.push({ field, code: 'NOT_A_NUMBER' });
        continue;
      }
      if (rule.min != null && n < rule.min) errors.push({ field, code: 'MIN' });
      if (rule.max != null && n > rule.max) errors.push({ field, code: 'MAX' });
      v = n;
    } else if (rule.type === 'boolean') {
      if (typeof v !== 'boolean') {
        errors.push({ field, code: 'NOT_A_BOOLEAN' });
        continue;
      }
    } else if (rule.type === 'phone') {
      const s = String(v);
      if (!PHONE_RE.test(s)) errors.push({ field, code: 'INVALID_PHONE' });
      v = s;
    } else {
      // string (default)
      const s = String(v);
      if (rule.minLength != null && s.length < rule.minLength)
        errors.push({ field, code: 'MIN_LENGTH' });
      if (rule.maxLength != null && s.length > rule.maxLength)
        errors.push({ field, code: 'MAX_LENGTH' });
      if (rule.pattern && !rule.pattern.test(s)) errors.push({ field, code: 'PATTERN' });
      v = s;
    }

    if (rule.enum && !rule.enum.includes(v)) errors.push({ field, code: 'ENUM' });
    value[field] = v;
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

module.exports = { validate, PHONE_RE };
