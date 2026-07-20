'use strict';

/**
 * Audit Service (Phase 14.7 / ADR-026) — the immutable, append-only Audit Kernel.
 * Records significant business/platform events for traceability, compliance, and
 * forensics. NOT application logging, NOT observability.
 *
 * The provider persists records; the engine owns integrity (checksum + hash
 * chain) and query behavior. Appends are serialized per namespace so each
 * record's sequence + prevChecksum link correctly (a tamper-evident chain).
 * Lifecycle events flow ONLY through the EventPublisher port. Deterministic.
 */

const { createRecord, verifyChecksum, GENESIS } = require('../../domain/audit/record');
const query = require('../../domain/audit/query');
const { AUDIT_EVENTS, createAuditEvent } = require('../../domain/audit/events');
const { AuditValidationError } = require('../../domain/audit/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createAuditService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };

  // Per-namespace append serialization → correct sequence/prevChecksum linkage.
  const _chains = new Map();
  function _appendExclusive(namespace, fn) {
    const prev = _chains.get(namespace) || Promise.resolve();
    const run = prev.then(fn, fn);
    _chains.set(
      namespace,
      run.then(
        () => {},
        () => {}
      )
    );
    return run;
  }

  function _emit(type, payload) {
    try {
      const event = createAuditEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('audit: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('audit: could not build event', e.message);
    }
  }

  // ── §1 record (append-only) ────────────────────────────────────────────────
  function record(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    if (!spec || !spec.action) throw new AuditValidationError('audit: "action" is required');
    return _appendExclusive(namespace, async () => {
      let tail;
      try {
        tail = await provider.tail(namespace);
      } catch (e) {
        if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
        throw e;
      }
      const chain = {
        sequence: tail ? tail.sequence + 1 : 0,
        prevChecksum: tail ? tail.checksum : GENESIS,
      };
      const rec = createRecord(spec, chain, { clock, idFactory: deps.idFactory });
      try {
        await provider.append(namespace, rec);
      } catch (e) {
        if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
        throw e;
      }
      if (metrics) metrics.recordWritten();
      _emit(AUDIT_EVENTS.RECORDED, {
        auditId: rec.auditId,
        namespace,
        action: rec.action,
        actor: rec.actor,
        category: rec.category,
        severity: rec.severity,
        correlationId: rec.correlationId,
        sequence: rec.sequence,
      });
      return rec;
    });
  }

  // ── §1 query / get ─────────────────────────────────────────────────────────
  async function queryFn(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const start = clock();
    let records;
    try {
      records = await provider.scan(namespace);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
    const out = query.evaluate(records, spec);
    if (metrics) {
      metrics.recordQuery();
      metrics.recordQueryLatency(clock() - start);
    }
    return out;
  }

  async function get(namespace, auditId) {
    const ns = auditId === undefined ? 'default' : namespace;
    const id = auditId === undefined ? namespace : auditId;
    try {
      return await provider.get(ns, id);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }

  // ── §1 verify (integrity: checksum + hash chain) ───────────────────────────
  async function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    let records;
    try {
      records = await provider.scan(namespace);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
    const issues = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!verifyChecksum(rec)) {
        issues.push({ auditId: rec.auditId, sequence: rec.sequence, reason: 'checksum mismatch' });
        if (metrics) metrics.recordChecksumFailure();
      }
      const expectedPrev = i === 0 ? GENESIS : records[i - 1].checksum;
      if (rec.prevChecksum !== expectedPrev) {
        issues.push({ auditId: rec.auditId, sequence: rec.sequence, reason: 'chain break' });
      }
      if (rec.sequence !== i) {
        issues.push({ auditId: rec.auditId, sequence: rec.sequence, reason: 'sequence gap' });
      }
    }
    const ok = issues.length === 0;
    if (metrics) metrics.recordVerification(ok);
    if (ok) {
      _emit(AUDIT_EVENTS.VERIFIED, { namespace, count: records.length });
    } else {
      _emit(AUDIT_EVENTS.INTEGRITY_FAILURE, { namespace, issues: issues.length });
    }
    return { ok, checked: records.length, issues };
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  return {
    record,
    query: queryFn,
    get,
    verify,
    health,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createAuditService };
