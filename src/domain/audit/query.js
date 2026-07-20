'use strict';

/**
 * Audit query evaluation (Phase 14.7 / ADR-026 §3) — PURE domain, deterministic.
 * A provider-agnostic filter/sort/paginate over already-loaded audit records for
 * timeline reconstruction and forensic lookup. Filters are exact-match on the
 * record's own fields plus time-range and metadata dotted paths.
 *
 * filter: {
 *   actor?, subject?, action?, resource?, category?, severity?,
 *   correlationId?, conversationId?, workflowId?, messageId?,
 *   from?, to?,                 // timestamp range (inclusive)
 *   'metadata.x'?               // dotted metadata match
 * }
 * sort: 'asc' | 'desc' (by sequence, then timestamp) — default asc (append order)
 * limit / offset
 */

const FIELDS = [
  'actor',
  'subject',
  'action',
  'resource',
  'category',
  'severity',
  'correlationId',
  'conversationId',
  'workflowId',
  'messageId',
];

function _matches(rec, filter = {}) {
  for (const f of FIELDS) {
    if (filter[f] !== undefined && rec[f] !== filter[f]) return false;
  }
  if (filter.from !== undefined && rec.timestamp < filter.from) return false;
  if (filter.to !== undefined && rec.timestamp > filter.to) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('metadata.')) {
      const path = k.slice('metadata.'.length);
      if ((rec.metadata && rec.metadata[path]) !== v) return false;
    }
  }
  return true;
}

function evaluate(records, spec = {}) {
  const out = (
    spec.filter ? records.filter((r) => _matches(r, spec.filter)) : records.slice()
  ).sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp);
  if (spec.sort === 'desc') out.reverse();
  const start = typeof spec.offset === 'number' && spec.offset > 0 ? spec.offset : 0;
  const end = typeof spec.limit === 'number' && spec.limit >= 0 ? start + spec.limit : undefined;
  return out.slice(start, end);
}

module.exports = { evaluate };
