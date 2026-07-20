'use strict';

/**
 * Feature Flag Service (Phase 15.0 / ADR-029) — the Feature Flag Kernel. Platform-
 * wide, deterministic feature evaluation, gradual rollout, version/platform/region/
 * tenant/environment targeting, and controlled activation. This is NOT LaunchDarkly/
 * Unleash/Firebase Remote Config and NOT an experimentation framework.
 *
 * The provider STORES flag definitions; ALL feature behavior lives here + in the
 * pure evaluation engine: deterministic evaluation, rule composition, conflict
 * resolution (priority ordering), percentage rollout (deterministic hashing),
 * evaluation explanation, an integrity-keyed evaluation cache, and lifecycle.
 * Lifecycle + evaluation events flow ONLY through the EventPublisher port. Fully
 * dependency-injected and deterministic; mutations are atomic per-flag via a
 * serialization mutex.
 */

const { createFlag, fromModel, stableStringify } = require('../../domain/features/flag');
const { evaluateFlag } = require('../../domain/features/evaluation');
const { FEATURE_EVENTS, createFeatureEvent } = require('../../domain/features/events');
const {
  FeatureValidationError,
  FeatureNotFoundError,
  IntegrityError,
} = require('../../domain/features/errors');
const { checksum } = require('../../domain/extensions/integrity');
const { assertProvider } = require('./providerPort');
const { createEvaluationCache } = require('./cache');
const { createNullPublisher } = require('../shared/eventPublisher');

function createFeaturesService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const cache = deps.cache || createEvaluationCache({ maxSize: deps.cacheMaxSize });

  // Per-flag index (namespace -> Map(name -> state)) — gauges + verification scans.
  const _index = new Map();
  function _indexSet(namespace, name, state) {
    if (!_index.has(namespace)) _index.set(namespace, new Map());
    _index.get(namespace).set(name, state);
  }
  function _indexRemove(namespace, name) {
    const m = _index.get(namespace);
    if (m) m.delete(name);
  }
  function _countByState(state) {
    let n = 0;
    for (const m of _index.values()) for (const s of m.values()) if (s === state) n += 1;
    return n;
  }
  function _countAll() {
    let n = 0;
    for (const m of _index.values()) n += m.size;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      registeredFlags: () => _countAll(),
      enabledFlags: () => _countByState('enabled'),
      disabledFlags: () => _countByState('disabled'),
    });
  }

  // Lifecycle history (bounded ring).
  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, namespace, name) {
    _lifecycle.push({ type, namespace, name, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }

  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  // Per-key serialization mutex — atomic read-modify-write for mutations.
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
      const event = createFeatureEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('features: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('features: could not build event', e.message);
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

  // ── §1 register ────────────────────────────────────────────────────────────────
  function register(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const key = `${namespace}::${spec.name}`;
    return _withLock(key, async () => {
      if (!spec.name || typeof spec.name !== 'string') {
        throw new FeatureValidationError('features: "name" is required');
      }
      const existing = await _safe(() => provider.getFlag(namespace, spec.name));
      if (existing) {
        throw new FeatureValidationError(
          `features: "${spec.name}" already exists in "${namespace}" (use update)`
        );
      }
      const flag = createFlag({ ...spec, namespace }, { clock, idFactory: idOpts.idFactory });
      await _safe(() => provider.putFlag(namespace, flag.toModel()));
      _indexSet(namespace, flag.name, flag.state);
      cache.invalidate(namespace, flag.name);
      if (metrics) metrics.recordRegistered();
      _recordLifecycle('registered', namespace, flag.name);
      _emit(FEATURE_EVENTS.REGISTERED, {
        flagId: flag.flagId,
        namespace,
        name: flag.name,
        state: flag.state,
        version: flag.version,
      });
      return flag.toPublic();
    });
  }

  // ── §1 evaluate (deterministic + explained; cached by checksum) ──────────────────
  function evaluate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = spec.name;
    const context = spec.context || opts.context || {};
    return (async () => {
      if (!name) throw new FeatureValidationError('features: evaluate requires a name');
      const start = clock();
      const model = await _safe(() => provider.getFlag(namespace, name));
      if (!model) {
        if (metrics) metrics.recordRejection();
        _emit(FEATURE_EVENTS.REJECTED, { namespace, name, reason: 'not_found' });
        throw new FeatureNotFoundError(`features: "${name}" not found in "${namespace}"`);
      }
      const cacheKey = `${namespace}:${name}:${model.checksum}:${checksum(stableStringify(context))}`;
      const cached = cache.get(cacheKey);
      let result;
      if (cached !== undefined) {
        if (metrics) metrics.recordCacheHit();
        result = cached;
      } else {
        if (metrics) metrics.recordCacheMiss();
        const flag = fromModel(model, { clock });
        // Definition integrity: a tampered stored definition must not be served.
        if (!flag.verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          _emit(FEATURE_EVENTS.REJECTED, { namespace, name, reason: 'integrity' });
          throw new IntegrityError(`features: integrity check failed for "${name}"`);
        }
        const evalResult = evaluateFlag(flag.toModel(), context);
        result = Object.freeze({
          flag: name,
          flagId: model.flagId,
          namespace,
          version: model.version,
          checksum: model.checksum,
          ...evalResult,
        });
        cache.set(cacheKey, result);
      }
      if (metrics) {
        metrics.recordEvaluation();
        metrics.recordLatency(clock() - start);
        if (!result.served) metrics.recordRejection();
      }
      _emit(result.served ? FEATURE_EVENTS.EVALUATED : FEATURE_EVENTS.REJECTED, {
        namespace,
        name,
        reason: result.reason,
        served: result.served,
        version: model.version,
      });
      return result;
    })();
  }

  function _mutate(namespace, name, apply, lifecycle, eventType) {
    const key = `${namespace}::${name}`;
    return _withLock(key, async () => {
      const model = await _safe(() => provider.getFlag(namespace, name));
      if (!model) throw new FeatureNotFoundError(`features: "${name}" not found in "${namespace}"`);
      const flag = fromModel(model, { clock });
      apply(flag);
      await _safe(() => provider.putFlag(namespace, flag.toModel()));
      _indexSet(namespace, name, flag.state);
      cache.invalidate(namespace, name);
      _recordLifecycle(lifecycle, namespace, name);
      _emit(eventType, {
        flagId: flag.flagId,
        namespace,
        name,
        state: flag.state,
        version: flag.version,
      });
      return flag.toPublic();
    });
  }

  // ── §1 enable / disable ──────────────────────────────────────────────────────────
  function enable(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = typeof spec === 'string' ? spec : spec.name;
    return _mutate(namespace, name, (f) => f.enable(clock()), 'enabled', FEATURE_EVENTS.ENABLED);
  }
  function disable(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = typeof spec === 'string' ? spec : spec.name;
    return _mutate(namespace, name, (f) => f.disable(clock()), 'disabled', FEATURE_EVENTS.DISABLED);
  }

  // ── §1 update ────────────────────────────────────────────────────────────────────
  function update(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const name = spec.name;
    const patch = spec.patch || spec.update || spec;
    return _mutate(
      namespace,
      name,
      (f) => f.applyUpdate(patch, clock()),
      'updated',
      FEATURE_EVENTS.UPDATED
    );
  }

  // ── §1 list ──────────────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listFlags(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }

  // ── §1/§9 verify (definition integrity + provider consistency) ────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const names = _index.get(namespace) || new Map();
      for (const name of names.keys()) {
        const model = await _safe(() => provider.getFlag(namespace, name));
        if (!model) {
          issues.push({ name, reason: 'missing in provider' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ name, reason: 'checksum mismatch' });
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
      flags: _countAll(),
      enabled: _countByState('enabled'),
      disabled: _countByState('disabled'),
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── diagnostics / snapshot / history (additive) ──────────────────────────────────
  async function snapshotFlag(namespace, name) {
    const m = await _safe(() => provider.getFlag(namespace, name));
    return m ? _deepFreeze(fromModel(m, { clock }).toPublic()) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      flags: (_index.get(namespace) || new Map()).size,
      totalFlags: _countAll(),
      enabled: _countByState('enabled'),
      disabled: _countByState('disabled'),
      namespaces: _index.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));
  const clearCache = () => cache.clear();

  return {
    register,
    evaluate,
    enable,
    disable,
    update,
    list,
    verify,
    health,
    // additive helpers
    snapshotFlag,
    diagnostics,
    history,
    clearCache,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createFeaturesService };
