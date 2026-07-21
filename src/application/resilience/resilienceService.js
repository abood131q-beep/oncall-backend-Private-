'use strict';

/**
 * Resilience Service (Phase 15.7 / ADR-036) — the Resilience Kernel. Platform-wide,
 * deterministic fault tolerance, execution protection, failure recovery, and
 * resilience policy orchestration. This is NOT Hystrix/Resilience4j/Polly — those
 * are libraries; this is a kernel behind a narrow port.
 *
 * Providers persist policies + circuit/execution state; ALL behavior lives here +
 * in the pure domain: deterministic execution, circuit breaker, retry with
 * configurable backoff, execution timeout, fallback execution, bulkhead isolation,
 * failure classification, recovery evaluation, policy verification, and execution
 * history. Events flow ONLY through the EventPublisher port. Deterministic: injected
 * clock. Circuit transitions are atomic via a per-(policy,subject) serialization
 * mutex; the protected call runs outside the lock so the bulkhead governs real
 * concurrency.
 */

const { createPolicy, fromModel } = require('../../domain/resilience/policy');
const circuit = require('../../domain/resilience/circuit');
const { classify } = require('../../domain/resilience/classify');
const { RESILIENCE_EVENTS, createResilienceEvent } = require('../../domain/resilience/events');
const {
  ResilienceValidationError,
  PolicyNotFoundError,
  CircuitOpenError,
  BulkheadFullError,
  ExecutionTimeoutError,
  IntegrityError,
} = require('../../domain/resilience/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createResilienceService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idFactory =
    deps.idFactory ||
    ((p) => `${p}_${clock().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  const _policyIndex = new Map(); // namespace -> Set(policyId)
  const _stateIndex = new Map(); // `${ns}::${key}` -> circuit state string
  const _active = new Map(); // `${ns}::${policyId}` -> in-flight count (bulkhead)

  function _indexAdd(ns, id) {
    if (!_policyIndex.has(ns)) _policyIndex.set(ns, new Set());
    _policyIndex.get(ns).add(id);
  }
  function _countPolicies() {
    let n = 0;
    for (const s of _policyIndex.values()) n += s.size;
    return n;
  }
  function _countState(status) {
    let n = 0;
    for (const s of _stateIndex.values()) if (s === status) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      policies: () => _countPolicies(),
      openCircuits: () => _countState('open'),
      closedCircuits: () => _countState('closed'),
    });
  }

  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, ns, id) {
    _lifecycle.push({ type, namespace: ns, id, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
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
      const event = createResilienceEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('resilience: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('resilience: could not build event', e.message);
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

  const _stateKey = (policyId, subject) => `${policyId}::${subject != null ? subject : '_'}`;
  const _fullKey = (ns, key) => `${ns}::${key}`;

  async function _loadState(ns, key) {
    const s = await _safe(() => provider.getState(ns, key));
    return s || circuit.initialState();
  }
  async function _saveState(ns, key, state) {
    await _safe(() => provider.putState(ns, key, state));
    _stateIndex.set(_fullKey(ns, key), state.state);
  }

  async function _resolvePolicy(namespace, policyId) {
    const model = await _safe(() => provider.getPolicy(namespace, policyId));
    if (!model)
      throw new PolicyNotFoundError(`resilience: policy "${policyId}" not found in "${namespace}"`);
    const policy = fromModel(model, { clock });
    if (!policy.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(`resilience: integrity check failed for policy "${policyId}"`);
    }
    return policy;
  }

  // ── §1 registerPolicy ─────────────────────────────────────────────────────────
  function registerPolicy(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const policy = createPolicy({ ...spec, namespace }, { clock, idFactory });
      const existing = await _safe(() => provider.getPolicy(namespace, policy.policyId));
      if (existing) {
        throw new ResilienceValidationError(
          `resilience: policy "${policy.policyId}" already exists in "${namespace}"`
        );
      }
      await _safe(() => provider.putPolicy(namespace, policy.toModel()));
      _indexAdd(namespace, policy.policyId);
      _recordLifecycle('registered', namespace, policy.policyId);
      _emit(RESILIENCE_EVENTS.POLICY_REGISTERED, {
        policyId: policy.policyId,
        namespace,
        strategy: policy.strategy,
      });
      return policy.toPublic();
    })();
  }

  // Run fn with deterministic timeout detection (injected clock).
  async function _runWithTimeout(fn, args, timeout) {
    const start = clock();
    const result = await fn(args);
    if (timeout != null && clock() - start > timeout) {
      throw new ExecutionTimeoutError(`resilience: execution exceeded timeout ${timeout}ms`);
    }
    return result;
  }

  // ── §1 execute (the protected execution) ────────────────────────────────────────
  function execute(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      if (typeof spec.fn !== 'function') {
        throw new ResilienceValidationError('resilience: execute requires a "fn" function');
      }
      const policy = await _resolvePolicy(namespace, spec.policyId);
      const subject = spec.subject != null ? spec.subject : null;
      const key = _stateKey(policy.policyId, subject);
      const activeKey = `${namespace}::${policy.policyId}`;
      const executionId = idFactory('exec');
      const max = policy.bulkhead.maxConcurrent;

      // Bulkhead isolation (governs real concurrency; checked before the lock).
      const active = _active.get(activeKey) || 0;
      if (max > 0 && active >= max) {
        if (metrics) metrics.recordBulkheadRejection();
        if (typeof spec.fallback === 'function') {
          return _runFallback(namespace, policy, executionId, spec, 'bulkhead');
        }
        throw new BulkheadFullError(`resilience: bulkhead full for "${policy.policyId}"`);
      }
      _active.set(activeKey, active + 1);

      if (metrics) metrics.recordExecution();
      _emit(RESILIENCE_EVENTS.EXECUTION_STARTED, {
        executionId,
        namespace,
        policyId: policy.policyId,
      });

      try {
        // Circuit gate (atomic).
        const gate = await _withLock(_fullKey(namespace, key), async () => {
          const state = await _loadState(namespace, key);
          const ca = circuit.canAttempt(state, policy, clock());
          if (ca.transitioned) {
            await _saveState(namespace, key, ca.state);
            if (ca.transitioned === circuit.CIRCUIT.HALF_OPEN) {
              _emit(RESILIENCE_EVENTS.CIRCUIT_HALF_OPENED, {
                namespace,
                policyId: policy.policyId,
              });
            }
          }
          return ca;
        });
        if (!gate.allowed) {
          if (typeof spec.fallback === 'function') {
            return await _runFallback(namespace, policy, executionId, spec, 'circuit_open');
          }
          throw new CircuitOpenError(`resilience: circuit open for "${policy.policyId}"`);
        }

        // Retry loop (with deterministic backoff; failure classification).
        let attempt = 0;
        let lastErr = null;
        while (attempt < policy.retryPolicy.maxAttempts) {
          attempt += 1;
          try {
            const result = await _runWithTimeout(spec.fn, spec.args, policy.timeout);
            await _commitSuccess(namespace, policy, key);
            if (metrics) metrics.recordSuccess();
            _emit(RESILIENCE_EVENTS.EXECUTION_SUCCEEDED, {
              executionId,
              namespace,
              policyId: policy.policyId,
              attempts: attempt,
            });
            return { ok: true, executionId, result, attempts: attempt, fallback: false };
          } catch (err) {
            lastErr = err;
            const cls = classify(err);
            if (err && err.name === 'ExecutionTimeoutError' && metrics) metrics.recordTimeout();
            if (cls.retriable && attempt < policy.retryPolicy.maxAttempts) {
              if (metrics) metrics.recordRetry();
              // Deterministic backoff delay is computed (advisory); no wall-clock sleep.
              void policy.nextDelayMs(attempt);
              continue;
            }
            break;
          }
        }

        // Final failure → circuit failure + optional fallback.
        await _commitFailure(namespace, policy, key, lastErr);
        if (metrics) metrics.recordFailure();
        _emit(RESILIENCE_EVENTS.EXECUTION_FAILED, {
          executionId,
          namespace,
          policyId: policy.policyId,
          attempts: attempt,
          reason: lastErr && lastErr.message,
        });
        if (typeof spec.fallback === 'function') {
          return await _runFallback(namespace, policy, executionId, spec, 'failure', lastErr);
        }
        throw lastErr;
      } finally {
        _active.set(activeKey, (_active.get(activeKey) || 1) - 1);
      }
    })();
  }

  async function _commitSuccess(namespace, policy, key) {
    return _withLock(_fullKey(namespace, key), async () => {
      const state = await _loadState(namespace, key);
      const r = circuit.onSuccess(state, policy, clock());
      await _saveState(namespace, key, r.state);
      if (r.transitioned === circuit.CIRCUIT.CLOSED) {
        _emit(RESILIENCE_EVENTS.CIRCUIT_CLOSED, { namespace, policyId: policy.policyId });
        _emit(RESILIENCE_EVENTS.RECOVERY_COMPLETED, { namespace, policyId: policy.policyId });
        _recordLifecycle('recovered', namespace, policy.policyId);
      }
    });
  }

  async function _commitFailure(namespace, policy, key, err) {
    return _withLock(_fullKey(namespace, key), async () => {
      const state = await _loadState(namespace, key);
      const r = circuit.onFailure(state, policy, clock());
      r.state.lastError = err && err.message ? err.message : 'error';
      await _saveState(namespace, key, r.state);
      if (r.transitioned === circuit.CIRCUIT.OPEN) {
        _emit(RESILIENCE_EVENTS.CIRCUIT_OPENED, { namespace, policyId: policy.policyId });
        _recordLifecycle('circuit_opened', namespace, policy.policyId);
      }
    });
  }

  async function _runFallback(namespace, policy, executionId, spec, reason, err) {
    const result = await spec.fallback({
      reason,
      error: err ? err.message : null,
      args: spec.args,
    });
    if (metrics) metrics.recordFallback();
    _emit(RESILIENCE_EVENTS.FALLBACK_EXECUTED, {
      executionId,
      namespace,
      policyId: policy.policyId,
      reason,
    });
    return { ok: true, executionId, result, fallback: true, reason };
  }

  // ── §1 evaluate (dry: circuit state + whether allowed) ────────────────────────────
  function evaluate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const policy = await _resolvePolicy(namespace, spec.policyId);
      const key = _stateKey(policy.policyId, spec.subject);
      const state = await _loadState(namespace, key);
      const ca = circuit.canAttempt(state, policy, clock());
      return {
        namespace,
        policyId: policy.policyId,
        subject: spec.subject != null ? spec.subject : null,
        circuit: state.state,
        allowed: ca.allowed,
        wouldTransition: ca.transitioned,
        failures: state.failures,
        successes: state.successes,
        openedAt: state.openedAt,
      };
    })();
  }

  // ── §1 reset (clear circuit state) ────────────────────────────────────────────────
  function reset(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const policyId = spec.policyId;
    const key = _stateKey(policyId, spec.subject);
    return _withLock(_fullKey(namespace, key), async () => {
      const removed = await _safe(() => provider.resetState(namespace, key));
      _stateIndex.delete(_fullKey(namespace, key));
      _recordLifecycle('reset', namespace, policyId);
      _emit(RESILIENCE_EVENTS.RECOVERY_COMPLETED, { namespace, policyId, reason: 'reset' });
      return Boolean(removed);
    });
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
      openCircuits: _countState('open'),
      closedCircuits: _countState('closed'),
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
  function diagnostics(namespace = 'default') {
    return {
      policies: (_policyIndex.get(namespace) || new Set()).size,
      totalPolicies: _countPolicies(),
      openCircuits: _countState('open'),
      closedCircuits: _countState('closed'),
      namespaces: _policyIndex.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerPolicy,
    execute,
    evaluate,
    reset,
    verify,
    health,
    // additive helpers
    list,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createResilienceService };
