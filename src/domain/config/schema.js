'use strict';

/**
 * Configuration schema validation engine (Phase 14.3.2 §4) — PURE domain.
 *
 * Dependency-free. Validates a flat or nested configuration object against a
 * declarative schema and returns a NORMALIZED result (defaults applied) or a
 * complete list of errors. Rejects invalid configuration before activation.
 *
 * Supported per-field rules:
 *   type        'string'|'number'|'integer'|'boolean'|'object'|'array'
 *   required    boolean (default false → optional)
 *   default     applied when the value is absent
 *   enum        [allowed values]
 *   min / max   numeric bounds (also length bounds for string/array)
 *   pattern     regex source string (for type 'string')
 *   validate    custom (value) => true | string  (string = error message)
 *   properties  nested object schema (type 'object')
 *   items       element schema (type 'array')
 *
 * A schema is: { properties: { key: fieldSchema }, required?: [key] }.
 */

function actualType(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, value) {
  const t = actualType(value);
  if (expected === 'number') return t === 'number' || t === 'integer';
  if (expected === 'integer') return t === 'integer';
  return t === expected;
}

/**
 * @param {any} value
 * @param {object} field field schema
 * @param {string} path dotted path (for error messages)
 * @param {string[]} errors accumulator
 * @returns {any} normalized value
 */
function validateField(value, field = {}, path, errors) {
  const present = value !== undefined && value !== null;

  if (!present) {
    if (field.default !== undefined) return field.default;
    if (field.required) errors.push(`"${path}" is required`);
    return undefined;
  }

  if (field.type && !typeMatches(field.type, value)) {
    errors.push(`"${path}" must be ${field.type}, got ${actualType(value)}`);
    return value;
  }

  if (field.enum && !field.enum.includes(value)) {
    errors.push(`"${path}" must be one of [${field.enum.join(', ')}]`);
  }

  if (typeof field.min === 'number') {
    const n = field.type === 'string' || field.type === 'array' ? value.length : value;
    if (typeof n === 'number' && n < field.min) {
      errors.push(`"${path}" must be >= ${field.min}`);
    }
  }
  if (typeof field.max === 'number') {
    const n = field.type === 'string' || field.type === 'array' ? value.length : value;
    if (typeof n === 'number' && n > field.max) {
      errors.push(`"${path}" must be <= ${field.max}`);
    }
  }

  if (field.pattern && field.type === 'string') {
    let re;
    try {
      re = new RegExp(field.pattern);
    } catch {
      errors.push(`"${path}" has an invalid pattern`);
    }
    if (re && !re.test(value)) errors.push(`"${path}" must match /${field.pattern}/`);
  }

  let normalized = value;

  if (field.type === 'object' && field.properties) {
    normalized = validateObject(value, field, path, errors);
  }

  if (field.type === 'array' && field.items) {
    normalized = value.map((el, i) => validateField(el, field.items, `${path}[${i}]`, errors));
  }

  if (typeof field.validate === 'function') {
    const r = field.validate(normalized);
    if (r !== true)
      errors.push(typeof r === 'string' ? `"${path}": ${r}` : `"${path}" failed custom validation`);
  }

  return normalized;
}

function validateObject(obj, schema, basePath, errors) {
  const props = (schema && schema.properties) || {};
  const requiredList = (schema && schema.required) || [];
  const out = {};

  // Mark required fields on their field schema so validateField enforces them.
  for (const [key, field] of Object.entries(props)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const isRequired = field.required || requiredList.includes(key);
    const normalized = validateField(
      obj ? obj[key] : undefined,
      { ...field, required: isRequired },
      path,
      errors
    );
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

/**
 * Validate a config object against a schema.
 * @returns {{ ok: boolean, value: object, errors: string[] }}
 */
function validate(config, schema) {
  const errors = [];
  if (!schema || !schema.properties) {
    // No schema → nothing to validate; pass through a shallow copy.
    return { ok: true, value: { ...(config || {}) }, errors };
  }
  const value = validateObject(config || {}, schema, '', errors);
  return { ok: errors.length === 0, value, errors };
}

module.exports = { validate, actualType };
