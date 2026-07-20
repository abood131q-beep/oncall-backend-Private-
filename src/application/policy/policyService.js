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
  const _cache = new Map(); // key -> result
  let _generation = 0; // bumps on any policy change → invalidates cache

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
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('policy: event publish failed', e.message)
      );
    } catch (e) {
      log.error('policy: could not build event', e.message);
    }
  }

  // ── §1 register ──────────────────────────────────────────────────────────
  async function register(spec = {}) {
    const namespace = spec.namespace || 'default';
    const entity = createPolicy({ ...spec, namespace }, { idFactory: deps.idFactory });
    const existed = nsMap(namespace).has(entity.policyId);
    nsMap(namespace).set(entity.policyId, entity);
    await provider.put(namespace, entity.toModel());
    _invalidate();
    if (metrics) metrics.recordRegistered();
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
      return _cache.get(cacheKey);
    }
    if (cacheKey && metrics) metrics.recordCache(false);

    const policies = [...(nsMap(namespace).values() || [])];
    const result = decisionEngine.evaluate(policies, request, { strategy });
    if (metrics) {
      metrics.recordDecision(result.allowed);
      metrics.recordLatency(clock() - start);
    }
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
    if (cacheKey) _cache.set(cacheKey, out);
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
    await provider.put(namespace, e.toModel());
    _invalidate();
    _emit(POLICY_EVENTS.ENABLED, { namespace, policyId });
    return e.toModel();
  }
  async function disable(namespace, policyId) {
    const e = _get(namespace, policyId);
    e.state = 'disabled';
    await provider.put(namespace, e.toModel());
    _invalidate();
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
      if (fresh.checksum !== e.checksum)
        issues.push({ policyId: e.policyId, reason: 'checksum mismatch' });
    }
    return { ok: issues.length === 0, issues };
  }

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
    STRATEGY: decisionEngine.STRATEGY,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createPolicyService };
