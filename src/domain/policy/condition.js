'use strict';

/**
 * Condition evaluation (Phase 14.6 / ADR-025) — PURE domain, deterministic. A
 * small, framework-free boolean expression evaluated against a context object.
 * NOT OPA/Cedar/Casbin — a self-contained condition language.
 *
 * Node forms:
 *   true | null | {}                      → always matches (unconditional)
 *   { all: [node...] }                    → AND (every child)
 *   { any: [node...] }                    → OR  (at least one)
 *   { not: node }                         → negation
 *   { field, op, value }                  → leaf comparison against context path
 *   { fn: (context) => bool }             → custom predicate (runtime only)
 *
 * Leaf operators: eq, ne, gt, gte, lt, lte, in, nin, contains, exists, regex.
 * Field is a dotted path resolved against the context.
 */

const { ConditionError } = require('./errors');

function getPath(ctx, field) {
  if (typeof field !== 'string') return undefined;
  let cur = ctx;
  for (const part of field.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function leaf(actual, op, value) {
  switch (op) {
    case 'eq':
      return actual === value;
    case 'ne':
      return actual !== value;
    case 'gt':
      return actual > value;
    case 'gte':
      return actual >= value;
    case 'lt':
      return actual < value;
    case 'lte':
      return actual <= value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'nin':
      return Array.isArray(value) && !value.includes(actual);
    case 'contains':
      return (
        (typeof actual === 'string' && actual.includes(value)) ||
        (Array.isArray(actual) && actual.includes(value))
      );
    case 'exists':
      return (actual !== undefined && actual !== null) === Boolean(value);
    case 'regex':
      try {
        return typeof actual === 'string' && new RegExp(value).test(actual);
      } catch {
        throw new ConditionError(`invalid regex "${value}"`);
      }
    default:
      throw new ConditionError(`unknown operator "${op}"`);
  }
}

/** Evaluate a condition node against a context. Deterministic; returns boolean. */
function evaluate(node, ctx) {
  if (node === true || node === null || node === undefined) return true;
  if (typeof node !== 'object') {
    throw new ConditionError('condition must be true/null or an object node');
  }
  if (Object.keys(node).length === 0) return true;
  if (Array.isArray(node.all)) return node.all.every((c) => evaluate(c, ctx));
  if (Array.isArray(node.any)) return node.any.some((c) => evaluate(c, ctx));
  if ('not' in node) return !evaluate(node.not, ctx);
  if (typeof node.fn === 'function') return Boolean(node.fn(ctx));
  if ('field' in node && 'op' in node) return leaf(getPath(ctx, node.field), node.op, node.value);
  throw new ConditionError('unrecognized condition node shape');
}

/** Validate a condition's structure (without a context) — throws on bad shape. */
function validate(node) {
  if (node === true || node === null || node === undefined) return true;
  if (typeof node !== 'object')
    throw new ConditionError('condition must be true/null or an object');
  if (Array.isArray(node.all)) return node.all.every(validate);
  if (Array.isArray(node.any)) return node.any.every(validate);
  if ('not' in node) return validate(node.not);
  if (typeof node.fn === 'function') return true;
  if (Object.keys(node).length === 0) return true;
  if ('field' in node && 'op' in node) {
    leaf(undefined, node.op, node.value === undefined ? null : node.value); // probe operator validity
    return true;
  }
  throw new ConditionError('unrecognized condition node shape');
}

module.exports = { evaluate, validate, getPath };
