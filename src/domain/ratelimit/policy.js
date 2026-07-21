'use strict';

/**
 * RatePolicy (Phase 15.2 / ADR-031 §2) — PURE domain value object. A
 * provider-agnostic rate-limit definition: limit, window, algorithm, optional
 * burst, priority, plus a content checksum for integrity. This is NOT Express
 * Rate Limit / NGINX / Redis middleware — those are provider/persistence details.
 *
 * Definition fields (persisted): policyId, name, namespace, subjectType, limit,
 * window, algorithm, burstLimit, priority, metadata, version, checksum.
 * Runtime fields (subject, currentUsage, remaining, resetTime) live on the
 * evaluation RESULT, not on the policy.
 */

const { RateLimitValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const ALGORITHMS = Object.freeze({
  FIXED_WINDOW: 'fixed_window',
  SLIDING_WINDOW: 'sliding_window',
  TOKEN_BUCKET: 'token_bucket',
  LEAKY_BUCKET: 'leaky_bucket',
});
const ALGO_SET = new Set(Object.values(ALGORITHMS));

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `rlp_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(p) {
  return {
    name: p.name,
    namespace: p.namespace,
    subjectType: p.subjectType,
    limit: p.limit,
    window: p.window,
    algorithm: p.algorithm,
    burstLimit: p.burstLimit,
    priority: p.priority,
    metadata: p.metadata,
  };
}

function computeChecksum(p) {
  return checksum(stableStringify(definitionOf(p)));
}

/**
 * @param {object} spec { name (required), limit (required), window (required ms),
 *   algorithm?, subjectType?, burstLimit?, priority?, metadata?, namespace?,
 *   policyId?, version? }
 * @param {object} [opts] { idFactory, clock }
 */
function createPolicy(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.name || typeof spec.name !== 'string') {
    throw new RateLimitValidationError('policy: "name" is required');
  }
  if (!Number.isFinite(spec.limit) || spec.limit <= 0) {
    throw new RateLimitValidationError('policy: "limit" must be a positive number');
  }
  if (!Number.isFinite(spec.window) || spec.window <= 0) {
    throw new RateLimitValidationError('policy: "window" (ms) must be a positive number');
  }
  const algorithm = spec.algorithm || ALGORITHMS.FIXED_WINDOW;
  if (!ALGO_SET.has(algorithm)) {
    throw new RateLimitValidationError(`policy: unknown algorithm "${algorithm}"`);
  }
  if (
    spec.burstLimit != null &&
    (!Number.isFinite(spec.burstLimit) || spec.burstLimit < spec.limit)
  ) {
    throw new RateLimitValidationError('policy: "burstLimit" must be a number >= limit');
  }
  const now = clock();
  const policy = {
    policyId: spec.policyId || idFactory(),
    name: spec.name,
    namespace: spec.namespace || 'default',
    subjectType: spec.subjectType || 'default',
    limit: spec.limit,
    window: spec.window,
    algorithm,
    burstLimit: spec.burstLimit != null ? spec.burstLimit : null,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    /** The effective ceiling: burst if declared, else the sustained limit. */
    capacity() {
      return this.burstLimit != null ? this.burstLimit : this.limit;
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
        subjectType: this.subjectType,
        limit: this.limit,
        window: this.window,
        algorithm: this.algorithm,
        burstLimit: this.burstLimit,
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
  policy.checksum = spec.checksum || computeChecksum(policy);
  return policy;
}

function fromModel(model, opts = {}) {
  const p = createPolicy(model, opts);
  p.createdAt = model.createdAt;
  p.updatedAt = model.updatedAt;
  p.version = model.version;
  p.checksum = model.checksum != null ? model.checksum : computeChecksum(p);
  return p;
}

module.exports = { createPolicy, fromModel, computeChecksum, stableStringify, ALGORITHMS };
