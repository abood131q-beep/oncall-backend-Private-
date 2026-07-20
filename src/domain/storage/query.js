'use strict';

/**
 * Query evaluation (Phase 14.3.4 §1 query) — PURE domain, deterministic. NOT an
 * ORM and not SQL: a small, provider-agnostic filter/sort/paginate over an array
 * of records already loaded by a provider. Matching is against each record's
 * `value` (documents) with dotted paths, plus the reserved fields `key` and
 * `collection`.
 *
 * where: { field: primitive }                      → equality
 *        { field: { op, value } }                  → op ∈ eq|ne|gt|gte|lt|lte|in|contains|exists
 * sort:  { field, dir: 'asc'|'desc' }
 * limit / offset: numbers
 */

function getPath(record, field) {
  if (field === 'key') return record.key;
  if (field === 'collection') return record.collection;
  const src = field.startsWith('metadata.') ? record.metadata : record.value;
  const path = field.startsWith('metadata.') ? field.slice('metadata.'.length) : field;
  let cur = src;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function matchOne(actual, matcher) {
  if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) {
    return actual === matcher; // equality shorthand
  }
  const { op, value } = matcher;
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
    case 'contains':
      return (
        (typeof actual === 'string' && actual.includes(value)) ||
        (Array.isArray(actual) && actual.includes(value))
      );
    case 'exists':
      return (actual !== undefined) === Boolean(value);
    default:
      throw new Error(`query: unknown operator "${op}"`);
  }
}

function matches(record, where = {}) {
  for (const [field, matcher] of Object.entries(where)) {
    if (!matchOne(getPath(record, field), matcher)) return false;
  }
  return true;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? -1 : 1;
}

/** Deterministic filter → sort → offset/limit over an array of records. */
function evaluate(records, { where, sort, limit, offset } = {}) {
  const out = where ? records.filter((r) => matches(r, where)) : records.slice();
  if (sort && sort.field) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const c = compare(getPath(a, sort.field), getPath(b, sort.field));
      return c !== 0 ? c * dir : compare(a.key, b.key) * dir; // stable tie-break by key
    });
  } else {
    out.sort((a, b) => compare(a.key, b.key)); // deterministic default order
  }
  const start = typeof offset === 'number' && offset > 0 ? offset : 0;
  const end = typeof limit === 'number' && limit >= 0 ? start + limit : undefined;
  return out.slice(start, end);
}

module.exports = { evaluate, matches, getPath };
