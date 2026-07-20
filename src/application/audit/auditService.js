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

  // Production hardening (A-001) — all additive.
  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = []; // ring: { type, namespace, at }
  const _queries = []; // ring: { namespace, filterKeys, count, at }
  function _recordLifecycle(type, namespace) {
    _lifecycle.push({ type, namespace, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _recordQueryHistory(namespace, spec, count) {
    _queries.push({
      namespace,
      filterKeys: spec && spec.filter ? Object.keys(spec.filter) : [],
      count,
      at: clock(),
    });
    if (_queries.length > historyLimit) _queries.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

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
      _recordLifecycle('recorded', namespace);
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
    _recordQueryHistory(namespace, spec, out.length);
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
      _recordLifecycle('verified', namespace);
      _emit(AUDIT_EVENTS.VERIFIED, { namespace, count: records.length });
    } else {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      _recordLifecycle('integrity-failure', namespace);
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

  // ── production hardening: snapshots, verification, reconciliation, diag ──────

  /** Immutable, deep-frozen snapshot of a single record (or null). */
  async function snapshot(namespace, auditId) {
    const ns = auditId === undefined ? 'default' : namespace;
    const id = auditId === undefined ? namespace : auditId;
    let rec;
    try {
      rec = await provider.get(ns, id);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
    return rec ? _deepFreeze({ ...rec, metadata: { ...rec.metadata } }) : null;
  }

  /** Startup verification: sane wiring before the engine is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!provider) problems.push('audit provider is required');
    if (typeof clock !== 'function' || typeof clock() !== 'number') {
      problems.push('clock must return a numeric ms epoch');
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Provider / namespace-consistency verification: the provider's reported count
   * must equal its scan length, `tail` must be the last scanned record, and
   * sequences must be contiguous (0..n-1). Detects a misbehaving provider.
   */
  async function verifyProvider(namespace = 'default') {
    const issues = [];
    let records;
    try {
      records = await provider.scan(namespace);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      return { ok: false, issues: [{ reason: `provider scan failed: ${e.message}` }] };
    }
    const count = provider.count(namespace);
    if (count !== records.length)
      issues.push({ reason: `count ${count} != scan ${records.length}` });
    const tail = provider.tail(namespace);
    if (records.length && (!tail || tail.auditId !== records[records.length - 1].auditId)) {
      issues.push({ reason: 'tail is not the last scanned record' });
    }
    for (let i = 0; i < records.length; i++) {
      if (records[i].sequence !== i) {
        issues.push({ sequence: records[i].sequence, reason: 'non-contiguous sequence' });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Chain reconciliation: find the longest intact prefix of the chain. Returns
   * the last-good sequence and the first break (if any). Never mutates history —
   * the audit trail is immutable; this only REPORTS the trustworthy boundary.
   */
  async function reconcile(namespace = 'default') {
    let records;
    try {
      records = await provider.scan(namespace);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
    let lastGoodSequence = -1;
    let firstBreak = null;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const expectedPrev = i === 0 ? GENESIS : records[i - 1].checksum;
      const ok = verifyChecksum(rec) && rec.prevChecksum === expectedPrev && rec.sequence === i;
      if (!ok) {
        firstBreak = { sequence: rec.sequence, auditId: rec.auditId };
        break;
      }
      lastGoodSequence = i;
    }
    return { ok: firstBreak === null, total: records.length, lastGoodSequence, firstBreak };
  }

  /**
   * Recovery after a provider failure: report the intact, trustworthy prefix so
   * a consumer can resume from a known-good boundary. History is append-only and
   * immutable — recovery never rewrites or deletes records.
   */
  async function recover(namespace = 'default') {
    const r = await reconcile(namespace);
    _recordLifecycle('recovered', namespace);
    return {
      ok: r.ok,
      intactThrough: r.lastGoodSequence,
      firstBreak: r.firstBreak,
      total: r.total,
    };
  }

  /** Query-determinism verification: the same query twice yields identical ids. */
  async function verifyQuery(spec = {}, opts = {}) {
    const a = await queryFn(spec, opts);
    const b = await queryFn(spec, opts);
    const ids = (rs) => rs.map((r) => r.auditId).join(',');
    return { ok: ids(a) === ids(b), count: a.length };
  }

  /** Structured diagnostics for dashboards / health checks. */
  async function diagnostics(namespace = 'default') {
    return {
      namespaceCount: provider.count(namespace),
      lifecycleDepth: _lifecycle.length,
      queryDepth: _queries.length,
      startup: verifyStartup(),
      chain: await reconcile(namespace),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  const history = () => _lifecycle.map((h) => ({ ...h }));
  const queryHistory = () => _queries.map((h) => ({ ...h }));

  return {
    record,
    query: queryFn,
    get,
    verify,
    health,
    // production hardening (additive)
    snapshot,
    verifyStartup,
    verifyProvider,
    reconcile,
    recover,
    verifyQuery,
    diagnostics,
    history,
    queryHistory,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createAuditService };
