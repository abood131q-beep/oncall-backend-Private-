'use strict';

/**
 * Rate Limiting Service (Phase 15.2 / ADR-031) — the Rate Limiting Kernel. Platform-
 * wide, deterministic request admission, quota management, and abuse protection.
 * This is NOT Express Rate Limit / NGINX / Redis middleware — those are provider/
 * persistence details.
 *
 * Providers persist policies + counters; ALL behavior lives here + in the pure
 * algorithms: deterministic evaluation (fixed/sliding window, token/leaky bucket),
 * burst handling, quota tracking, remaining calculation, priority resolution,
 * evaluation explanation, and a write-through usage cache. `evaluate` is a
 * side-effect-free dry run; `consume` mutates the counter atomically per
 * (policy, subject) via a serialization mutex. Lifecycle + admission events flow
 * ONLY through the EventPublisher port. Deterministic: injected clock.
 */

const { createPolicy, fromModel } = require('../../domain/ratelimit/policy');
const { evaluate: runAlgorithm } = require('../../domain/ratelimit/algorithms');
const { RATE_EVENTS, createRateEvent } = require('../../domain/ratelimit/events');
const {
  RateLimitValidationError,
  PolicyNotFoundError,
  IntegrityError,
} = require('../../domain/ratelimit/errors');
const { assertProvider } = require('./providerPort');
const { createUsageCache } = require('./cache');
const { createNullPublisher } = require('../shared/eventPublisher');

function createRateLimitService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const cache = deps.cache || createUsageCache({ maxSize: deps.cacheMaxSize });

  const _policyIndex = new Map(); // namespace -> Set(policyId)
  function _indexAdd(ns, id) {
    if (!_policyIndex.has(ns)) _policyIndex.set(ns, new Set());
    _policyIndex.get(ns).add(id);
  }
  function _countPolicies() {
    let n = 0;
    for (const s of _policyIndex.values()) n += s.size;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({ registeredPolicies: () => _countPolicies() });
  }

  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, ns, id) {
    _lifecycle.push({ type, namespace: ns, id, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  const _locks = new Map();
  function _withLock(key, fn) {
    const prev = _locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  function _emit(type, payload) {
    try {
      const event = createRateEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('ratelimit: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('ratelimit: could not build event', e.message);
    }
  }

  async function _safe(fn) {
    try {
      return await fn();
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }

  const _counterKey = (policyId, subject) => `${policyId}::${subject}`;
  const _cacheKey = (ns, key) => `${ns}:${key}`;

  async function _readCounter(ns, key) {
    const ck = _cacheKey(ns, key);
    const cached = cache.get(ck);
    if (cached !== undefined) {
      if (metrics) metrics.recordCacheHit();
      return cached;
    }
    if (metrics) metrics.recordCacheMiss();
    const state = await _safe(() => provider.getCounter(ns, key));
    cache.set(ck, state);
    return state;
  }
  async function _writeCounter(ns, key, state) {
    await _safe(() => provider.putCounter(ns, key, state));
    cache.set(_cacheKey(ns, key), state);
  }

  function _requireSubject(spec) {
    if (spec.subject == null || spec.subject === '') {
      throw new RateLimitValidationError('ratelimit: "subject" is required');
    }
    return String(spec.subject);
  }

  // Resolve the governing policy: explicit policyId, else highest-priority policy
  // matching the subjectType (priority resolution). Verifies integrity.
  async function _resolvePolicy(namespace, spec) {
    let model;
    if (spec.policyId) {
      model = await _safe(() => provider.getPolicy(namespace, spec.policyId));
    } else {
      const all = await _safe(() => provider.listPolicies(namespace));
      const matches = all
        .filter((p) => (spec.subjectType ? p.subjectType === spec.subjectType : true))
        .sort((a, b) => b.priority - a.priority || b.version - a.version);
      model = matches[0] || null;
    }
    if (!model) {
      throw new PolicyNotFoundError(
        `ratelimit: no policy found in "${namespace}" for ${spec.policyId || spec.subjectType || 'request'}`
      );
    }
    const policy = fromModel(model, { clock });
    if (!policy.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(`ratelimit: integrity check failed for policy "${policy.policyId}"`);
    }
    return policy;
  }

  function _explain(policy, subject, res, cost) {
    return {
      policyId: policy.policyId,
      namespace: policy.namespace,
      subject,
      subjectType: policy.subjectType,
      algorithm: policy.algorithm,
      allowed: res.allowed,
      cost,
      limit: policy.limit,
      burstLimit: policy.burstLimit,
      usage: res.usage,
      remaining: res.remaining,
      resetTime: res.resetTime,
      priority: policy.priority,
    };
  }

  // ── §1 registerPolicy ────────────────────────────────────────────────────────────
  function registerPolicy(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const policy = createPolicy({ ...spec, namespace }, { clock, idFactory: idOpts.idFactory });
      const existing = await _safe(() => provider.getPolicy(namespace, policy.policyId));
      if (existing) {
        throw new RateLimitValidationError(
          `ratelimit: policy "${policy.policyId}" already exists in "${namespace}"`
        );
      }
      await _safe(() => provider.putPolicy(namespace, policy.toModel()));
      _indexAdd(namespace, policy.policyId);
      _recordLifecycle('registered', namespace, policy.policyId);
      _emit(RATE_EVENTS.POLICY_REGISTERED, {
        policyId: policy.policyId,
        namespace,
        name: policy.name,
        algorithm: policy.algorithm,
        limit: policy.limit,
        window: policy.window,
      });
      return policy.toPublic();
    })();
  }

  // ── §1 evaluate (dry run — no mutation) ────────────────────────────────────────────
  function evaluate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const subject = _requireSubject(spec);
      const cost = spec.cost != null ? spec.cost : 1;
      const start = clock();
      const policy = await _resolvePolicy(namespace, spec);
      const key = _counterKey(policy.policyId, subject);
      const state = await _readCounter(namespace, key);
      const res = runAlgorithm(policy, state, clock(), cost);
      if (metrics) {
        metrics.recordEvaluation();
        metrics.recordLatency(clock() - start);
        if (res.allowed) metrics.recordAllowed();
        else metrics.recordBlocked();
      }
      _emit(RATE_EVENTS.EVALUATED, {
        policyId: policy.policyId,
        namespace,
        subject,
        allowed: res.allowed,
        remaining: res.remaining,
        resetTime: res.resetTime,
      });
      return _explain(policy, subject, res, cost);
    })();
  }

  // ── §1 consume (admission + mutate the counter) ────────────────────────────────────
  function consume(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const subject = _requireSubject(spec);
      const cost = spec.cost != null ? spec.cost : 1;
      const policy = await _resolvePolicy(namespace, spec);
      const key = _counterKey(policy.policyId, subject);
      return _withLock(`${namespace}::${key}`, async () => {
        const start = clock();
        const state = await _readCounter(namespace, key);
        const res = runAlgorithm(policy, state, clock(), cost);
        if (res.allowed) {
          await _writeCounter(namespace, key, res.stateIfConsumed);
          if (metrics) {
            metrics.recordAllowed();
            metrics.recordConsumption(cost);
          }
          _emit(RATE_EVENTS.CONSUMED, {
            policyId: policy.policyId,
            namespace,
            subject,
            cost,
            remaining: res.remaining,
            resetTime: res.resetTime,
          });
        } else {
          await _writeCounter(namespace, key, res.stateDecayed);
          if (metrics) metrics.recordBlocked();
          _emit(RATE_EVENTS.EXCEEDED, {
            policyId: policy.policyId,
            namespace,
            subject,
            remaining: res.remaining,
            resetTime: res.resetTime,
          });
        }
        if (metrics) {
          metrics.recordEvaluation();
          metrics.recordLatency(clock() - start);
        }
        return _explain(policy, subject, res, cost);
      });
    })();
  }

  // ── §1 reset ────────────────────────────────────────────────────────────────────
  function reset(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const subject = _requireSubject(spec);
      if (!spec.policyId) {
        throw new RateLimitValidationError('ratelimit: reset requires a policyId');
      }
      const key = _counterKey(spec.policyId, subject);
      return _withLock(`${namespace}::${key}`, async () => {
        const removed = await _safe(() => provider.resetCounter(namespace, key));
        cache.invalidate(_cacheKey(namespace, key));
        if (metrics) metrics.recordReset();
        _recordLifecycle('reset', namespace, spec.policyId);
        _emit(RATE_EVENTS.RESET, { policyId: spec.policyId, namespace, subject });
        return Boolean(removed);
      });
    })();
  }

  // ── §1/§9 verify (policy integrity across a namespace) ─────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _policyIndex.get(namespace) || new Set();
      for (const id of ids) {
        const model = await _safe(() => provider.getPolicy(namespace, id));
        if (!model) {
          issues.push({ policyId: id, reason: 'missing in provider' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ policyId: id, reason: 'checksum mismatch' });
        }
      }
      return { ok: issues.length === 0, issues };
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      policies: _countPolicies(),
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listPolicies(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  async function snapshotPolicy(namespace, policyId) {
    const m = await _safe(() => provider.getPolicy(namespace, policyId));
    return m ? _deepFreeze(fromModel(m, { clock }).toPublic()) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      policies: (_policyIndex.get(namespace) || new Set()).size,
      totalPolicies: _countPolicies(),
      namespaces: _policyIndex.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));
  const clearCache = () => cache.clear();

  return {
    registerPolicy,
    evaluate,
    consume,
    reset,
    verify,
    health,
    // additive helpers
    list,
    snapshotPolicy,
    diagnostics,
    history,
    clearCache,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createRateLimitService };
