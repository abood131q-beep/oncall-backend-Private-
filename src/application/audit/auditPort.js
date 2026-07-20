'use strict';

/**
 * Audit PORT (Phase 14.7 / ADR-026 §1) — the immutable, append-only audit
 * abstraction every Kernel Service and Extension depends on. Consumers see only
 * this contract, never the provider or engine internals:
 *
 *   record(spec, opts)   append one immutable audit record → the frozen record
 *   query(spec, opts)    filter/sort/paginate for timeline reconstruction
 *   get(ns, auditId)     fetch a single record by id
 *   verify(opts)         verify checksum + hash-chain integrity of a namespace
 *   health()             provider + metrics health
 *
 * `spec` for record: `{ action (required), actor?, subject?, resource?,
 * category?, severity?, correlationId?, conversationId?, workflowId?,
 * messageId?, metadata? }`. There is deliberately NO update or delete.
 */

const METHODS = Object.freeze(['record', 'query', 'get', 'verify', 'health']);

function assertAudit(a) {
  if (!a || typeof a !== 'object') throw new Error('Audit: adapter required');
  for (const m of METHODS) {
    if (typeof a[m] !== 'function') throw new Error(`Audit: adapter must implement ${m}()`);
  }
  return a;
}

module.exports = { assertAudit, METHODS };
