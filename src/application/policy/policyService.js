'use strict';

/**
 * Policy Service (Phase 14.6 / ADR-025) — the Policy Kernel. Evaluates decisions
 * consistently across all Kernel Services. NOT an authorization framework, NOT a
 * rule engine, NOT tied to OPA/Cedar/Casbin.
 *
 * The provider stores policy DEFINITIONS; the deterministic decision engine
 * (domain) performs evaluation. Live policy entities (with condition trees) are
 * held in-memory for evaluation and mirrored to the provider for persistence.
 * A generation-keyed decision cache accelerates repeated evaluations and is
 * invalidated on any policy change. Lifecycle events flow ONLY through the
 * EventPublisher port. Fully dependency-injected and deterministic.
 */

const { createPolicy } = require('../../domain/policy/policy');
const decisionEngine = require('../../domain/policy/decision');
const { POLICY_EVENTS, createPolicyEvent } = require('../../domain/policy/events');
const { PolicyError } = require('../../domain/policy/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createPolicyService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const defaultStrategy = deps.strategy || decisionEngine.STRATEGY.DENY_OVERRIDES;
  const cacheEnabled = deps.cache !== false;

  const _policies = new Map(); // namespace -> Map(policyId -> entity)
  const _cache = new Map(); // key -> { out, request, strategy }
  let _generation = 0; // bumps on any policy change → invalidates cache

  // Production hardening (A-001) — all additive.
  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = []; // ring: { type, policyId, namespace, at }
  const _decisions = []; // ring: { namespace, scope, decision, at }

  function _recordLifecycle(type, policyId, namespace) {
    _lifecycle.push({ type, policyId, namespace, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _recordDecisionHistory(namespace, scope, decision) {
    _decisions.push({ namespace, scope, decision, at: clock() });
    if (_decisions.length > historyLimit) _decisions.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }
  function _countByState(state) {
    let n = 0;
    for (const m of _policies.values()) for (const e of m.values()) if (e.state === state) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      enabled: () => _countByState('enabled'),
      disabled: () => _countByState('disabled'),
    });
  }

  /** Persist a policy model to the provider, counting provider failures. */
  async function _persist(namespace, model) {
    try {
      await provider.put(namespace, model);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }

  const nsMap = (namespace) => {
    if (!_policies.has(namespace)) _policies.set(namespace, new Map());
    return _policies.get(namespace);
  };
  const _invalidate = () => {
    _generation += 1;
    _cache.clear();
  };

  function _emit(type, payload) {
    try {
      const event = createPolicyEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('policy: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('policy: could not build event', e.message);
    }
  }

  // ── §1 register ──────────────────────────────────────────────────────────
  async function register(spec = {}) {
    const namespace = spec.namespace || 'default';
    const entity = createPolicy({ ...spec, namespace }, { idFactory: deps.idFactory });
    const existed = nsMap(namespace).has(entity.policyId);
    nsMap(namespace).set(entity.policyId, entity);
    await _persist(namespace, entity.toModel());
    _invalidate();
    if (metrics) metrics.recordRegistered();
    _recordLifecycle(existed ? 'updated' : 'registered', entity.policyId, namespace);
    _emit(existed ? POLICY_EVENTS.UPDATED : POLICY_EVENTS.REGISTERED, {
      policyId: entity.policyId,
      namespace,
      name: entity.name,
      scope: entity.scope,
      effect: entity.effect,
    });
    return entity.toModel();
  }

  function _get(namespace, policyId) {
    const m = _policies.get(namespace);
    const e = m && m.get(policyId);
    if (!e) throw new PolicyError(`policy "${policyId}" not found in namespace "${namespace}"`);
    return e;
  }

  // ── §1 evaluate / explain ──────────────────────────────────────────────────
  function _decide(request, opts, { explain }) {
    const namespace = (request && request.namespace) || 'default';
    const strategy = (opts && opts.strategy) || defaultStrategy;
    const start = clock();

    const cacheKey =
      cacheEnabled && !explain
        ? `${namespace}|${_generation}|${strategy}|${JSON.stringify(request)}`
        : null;
    if (cacheKey && _cache.has(cacheKey)) {
      if (metrics) metrics.recordCache(true);
      return _cache.get(cacheKey).out;
    }
    if (cacheKey && metrics) metrics.recordCache(false);

    const policies = [...(nsMap(namespace).values() || [])];
    const result = decisionEngine.evaluate(policies, request, { strategy });
    if (metrics) {
      metrics.recordDecision(result.allowed);
      metrics.recordLatency(clock() - start);
    }
    _recordDecisionHistory(namespace, request && request.scope, result.decision);
    _emit(POLICY_EVENTS.EVALUATED, {
      namespace,
      scope: request && request.scope,
      decision: result.decision,
      reason: result.reason,
      decidingPolicy: result.decidingPolicy && result.decidingPolicy.policyId,
    });
    if (!result.allowed) {
      _emit(POLICY_EVENTS.REJECTED, {
        namespace,
        scope: request && request.scope,
        reason: result.reason,
      });
    }
    const out = explain
      ? result
      : {
          allowed: result.allowed,
          decision: result.decision,
          reason: result.reason,
          decidingPolicy: result.decidingPolicy,
        };
    if (cacheKey) _cache.set(cacheKey, { out, request, strategy, namespace });
    return out;
  }

  function evaluate(request = {}, opts = {}) {
    return _decide(request, opts, { explain: false });
  }
  function explain(request = {}, opts = {}) {
    return _decide(request, opts, { explain: true }); // always fresh + full trace
  }

  // ── §1 enable / disable ─────────────────────────────────────────────────────
  async function enable(namespace, policyId) {
    const e = _get(namespace, policyId);
    e.state = 'enabled';
    await _persist(namespace, e.toModel());
    _invalidate();
    _recordLifecycle('enabled', policyId, namespace);
    _emit(POLICY_EVENTS.ENABLED, { namespace, policyId });
    return e.toModel();
  }
  async function disable(namespace, policyId) {
    const e = _get(namespace, policyId);
    e.state = 'disabled';
    await _persist(namespace, e.toModel());
    _invalidate();
    _recordLifecycle('disabled', policyId, namespace);
    _emit(POLICY_EVENTS.DISABLED, { namespace, policyId });
    return e.toModel();
  }

  // ── §1 list / health ─────────────────────────────────────────────────────────
  function list(spec = {}) {
    const namespace = spec.namespace || 'default';
    let out = [...(nsMap(namespace).values() || [])].map((e) => e.toModel());
    if (spec.scope) out = out.filter((p) => p.scope === spec.scope || p.scope === '*');
    if (spec.state) out = out.filter((p) => p.state === spec.state);
    return out.sort((a, b) => b.priority - a.priority || (a.policyId < b.policyId ? -1 : 1));
  }

  /** Integrity verification: recompute each policy's checksum and compare. */
  function verify(namespace = 'default') {
    const issues = [];
    for (const e of nsMap(namespace).values()) {
      const fresh = createPolicy(
        { ...e.toModel(), condition: e.condition },
        { idFactory: () => e.policyId }
      );
      if (fresh.checksum !== e.checksum) {
        issues.push({ policyId: e.policyId, reason: 'checksum mismatch' });
        if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      }
    }
    return { ok: issues.length === 0, issues };
  }

  // ── production hardening: snapshots, verification, recovery, diagnostics ────

  /** Immutable, deep-frozen snapshot of a single policy model (or null). */
  function snapshot(namespace, policyId) {
    const m = _policies.get(namespace || 'default');
    const e = m && m.get(policyId);
    return e ? _deepFreeze(e.toModel()) : null;
  }

  /** Startup verification: sane wiring before the engine is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!provider) problems.push('policy provider is required');
    if (typeof clock !== 'function' || typeof clock() !== 'number') {
      problems.push('clock must return a numeric ms epoch');
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Provider verification / checksum reconciliation: compare the in-memory
   * (authoritative) entities against the provider's stored definitions per
   * namespace. Detects drift, corruption, missing, and orphaned records.
   */
  async function verifyProvider(namespace = 'default') {
    const issues = [];
    let stored;
    try {
      stored = await provider.list(namespace);
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      return { ok: false, issues: [{ reason: `provider list failed: ${e.message}` }] };
    }
    const storedById = new Map(stored.map((m) => [m && m.policyId, m]));
    for (const e of nsMap(namespace).values()) {
      const m = storedById.get(e.policyId);
      if (!m) issues.push({ policyId: e.policyId, reason: 'missing in provider' });
      else if (!m.checksum)
        issues.push({ policyId: e.policyId, reason: 'corrupt provider record (no checksum)' });
      else if (m.checksum !== e.checksum)
        issues.push({ policyId: e.policyId, reason: 'checksum drift' });
      storedById.delete(e.policyId);
    }
    for (const orphanId of storedById.keys()) {
      issues.push({ policyId: orphanId, reason: 'orphan in provider (not in engine)' });
    }
    if (issues.length && metrics && metrics.recordIntegrityFailure)
      metrics.recordIntegrityFailure();
    return { ok: issues.length === 0, issues };
  }

  /** Decision-cache verification: re-evaluate each cached key fresh and compare. */
  function verifyCache() {
    const issues = [];
    for (const [key, entry] of _cache) {
      const fresh = decisionEngine.evaluate([...nsMap(entry.namespace).values()], entry.request, {
        strategy: entry.strategy,
      });
      if (fresh.decision !== entry.out.decision) {
        issues.push({
          key,
          reason: 'stale cache entry',
          cached: entry.out.decision,
          fresh: fresh.decision,
        });
      }
    }
    return { ok: issues.length === 0, issues, size: _cache.size };
  }

  /**
   * Recovery after a provider failure: re-persist the in-memory (authoritative)
   * entities to the provider, reconciling any drift. Returns repaired counts.
   */
  async function recover(namespace) {
    const namespaces = namespace ? [namespace] : [..._policies.keys()];
    let repaired = 0;
    const failures = [];
    for (const ns of namespaces) {
      for (const e of nsMap(ns).values()) {
        try {
          await provider.put(ns, e.toModel());
          repaired += 1;
        } catch (err) {
          if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
          failures.push({ policyId: e.policyId, error: err.message });
        }
      }
    }
    return { ok: failures.length === 0, repaired, failures };
  }

  /** Structured diagnostics for dashboards / health checks. */
  function diagnostics() {
    return {
      policies: _countByState('enabled') + _countByState('disabled'),
      enabled: _countByState('enabled'),
      disabled: _countByState('disabled'),
      namespaces: _policies.size,
      generation: _generation,
      cacheSize: _cache.size,
      lifecycleDepth: _lifecycle.length,
      decisionDepth: _decisions.length,
      startup: verifyStartup(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  const history = () => _lifecycle.map((h) => ({ ...h }));
  const evaluationHistory = () => _decisions.map((h) => ({ ...h }));

  async function health() {
    const providerHealth = await provider.health();
    let total = 0;
    for (const m of _policies.values()) total += m.size;
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      policies: total,
      generation: _generation,
      cacheSize: _cache.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  return {
    register,
    evaluate,
    explain,
    enable,
    disable,
    list,
    health,
    verify,
    // production hardening (additive)
    snapshot,
    verifyStartup,
    verifyProvider,
    verifyCache,
    recover,
    diagnostics,
    history,
    evaluationHistory,
    STRATEGY: decisionEngine.STRATEGY,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createPolicyService };
