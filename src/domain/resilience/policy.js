'use strict';

/**
 * ResiliencePolicy (Phase 15.7 / ADR-036 §2) — PURE domain value object. A
 * provider-agnostic fault-tolerance policy: strategy, circuit-breaker thresholds,
 * retry + backoff, timeout, fallback, and bulkhead limits, plus a content checksum.
 * This is NOT Hystrix/Resilience4j/Polly — those are libraries; this is a
 * deterministic policy the resilience engine consumes.
 *
 * Fields: policyId, namespace, targetService, strategy, retryPolicy, backoffPolicy,
 * timeout, fallbackStrategy, failureThreshold, successThreshold, recoveryWindow,
 * bulkhead, priority, metadata, version, checksum.
 */

const { ResilienceValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STRATEGIES = new Set([
  'composite',
  'circuit_breaker',
  'retry',
  'timeout',
  'fallback',
  'bulkhead',
]);

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `rp_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(p) {
  return {
    namespace: p.namespace,
    targetService: p.targetService,
    strategy: p.strategy,
    retryPolicy: p.retryPolicy,
    backoffPolicy: p.backoffPolicy,
    timeout: p.timeout,
    fallbackStrategy: p.fallbackStrategy,
    failureThreshold: p.failureThreshold,
    successThreshold: p.successThreshold,
    recoveryWindow: p.recoveryWindow,
    bulkhead: p.bulkhead,
    priority: p.priority,
    metadata: p.metadata,
  };
}

function computeChecksum(p) {
  return checksum(stableStringify(definitionOf(p)));
}

function normalizeRetry(spec) {
  const r = spec || {};
  const maxAttempts = r.maxAttempts == null ? 1 : Number(r.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ResilienceValidationError('policy: retryPolicy.maxAttempts must be an integer >= 1');
  }
  return { maxAttempts };
}

function normalizeBackoff(spec) {
  const b = spec || {};
  const strategy = b.strategy || 'exponential';
  if (!['none', 'fixed', 'exponential'].includes(strategy)) {
    throw new ResilienceValidationError(`policy: backoffPolicy.strategy "${strategy}" is invalid`);
  }
  return {
    strategy,
    baseMs: b.baseMs == null ? 0 : Number(b.baseMs),
    factor: b.factor == null ? 2 : Number(b.factor),
    maxMs: b.maxMs == null ? 0 : Number(b.maxMs),
  };
}

/**
 * @param {object} spec { name?, namespace?, targetService?, strategy?, retryPolicy?,
 *   backoffPolicy?, timeout?, fallbackStrategy?, failureThreshold?, successThreshold?,
 *   recoveryWindow?, bulkhead?, priority?, metadata?, policyId?, version? }
 * @param {object} [opts] { idFactory, clock }
 */
function createPolicy(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  const strategy = spec.strategy || 'composite';
  if (!STRATEGIES.has(strategy)) {
    throw new ResilienceValidationError(`policy: unknown strategy "${strategy}"`);
  }
  const failureThreshold = spec.failureThreshold == null ? 5 : Number(spec.failureThreshold);
  const successThreshold = spec.successThreshold == null ? 1 : Number(spec.successThreshold);
  const recoveryWindow = spec.recoveryWindow == null ? 30000 : Number(spec.recoveryWindow);
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new ResilienceValidationError('policy: failureThreshold must be an integer >= 1');
  }
  if (!Number.isInteger(successThreshold) || successThreshold < 1) {
    throw new ResilienceValidationError('policy: successThreshold must be an integer >= 1');
  }
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 0) {
    throw new ResilienceValidationError('policy: recoveryWindow must be a non-negative number');
  }
  const now = clock();
  const p = {
    policyId: spec.policyId || idFactory(),
    name: spec.name != null ? spec.name : spec.policyId || null,
    namespace: spec.namespace || 'default',
    targetService: spec.targetService != null ? spec.targetService : null,
    strategy,
    retryPolicy: normalizeRetry(spec.retryPolicy),
    backoffPolicy: normalizeBackoff(spec.backoffPolicy),
    timeout: spec.timeout != null ? Number(spec.timeout) : null,
    fallbackStrategy: spec.fallbackStrategy || 'none',
    failureThreshold,
    successThreshold,
    recoveryWindow,
    bulkhead:
      spec.bulkhead != null
        ? { maxConcurrent: Number(spec.bulkhead.maxConcurrent || 0) }
        : { maxConcurrent: 0 },
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    /** Deterministic backoff delay (ms) before the retry that follows `attempts`. */
    nextDelayMs(attempts) {
      const b = this.backoffPolicy;
      if (b.strategy === 'none' || !b.baseMs) return 0;
      const raw =
        b.strategy === 'fixed'
          ? b.baseMs
          : b.baseMs * Math.pow(b.factor, Math.max(0, attempts - 1));
      return b.maxMs > 0 ? Math.min(raw, b.maxMs) : raw;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    toModel() {
      return {
        policyId: this.policyId,
        name: this.name,
        namespace: this.namespace,
        targetService: this.targetService,
        strategy: this.strategy,
        retryPolicy: { ...this.retryPolicy },
        backoffPolicy: { ...this.backoffPolicy },
        timeout: this.timeout,
        fallbackStrategy: this.fallbackStrategy,
        failureThreshold: this.failureThreshold,
        successThreshold: this.successThreshold,
        recoveryWindow: this.recoveryWindow,
        bulkhead: { ...this.bulkhead },
        priority: this.priority,
        metadata: { ...this.metadata },
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        version: this.version,
        checksum: this.checksum,
      };
    },
    toPublic() {
      return this.toModel();
    },
  };
  p.checksum = spec.checksum || computeChecksum(p);
  return p;
}

function fromModel(model, opts = {}) {
  const p = createPolicy(model, opts);
  p.createdAt = model.createdAt;
  p.updatedAt = model.updatedAt;
  p.version = model.version;
  p.checksum = model.checksum != null ? model.checksum : computeChecksum(p);
  return p;
}

module.exports = { createPolicy, fromModel, computeChecksum, stableStringify, STRATEGIES };
