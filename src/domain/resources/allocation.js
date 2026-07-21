'use strict';

/**
 * Allocation (Phase 15.10 / ADR-039 §3) — PURE domain value object. A single claim
 * against a resource: owner, amount, priority, and lifecycle status, with a content
 * checksum for integrity. Deterministic; the engine persists these as the allocation
 * state and derives a resource's `allocated` total from the active set.
 */

const { ResourceValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATUS = Object.freeze({ ACTIVE: 'active', RELEASED: 'released', PREEMPTED: 'preempted' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `alc_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(a) {
  return {
    resourceId: a.resourceId,
    namespace: a.namespace,
    owner: a.owner,
    amount: a.amount,
    priority: a.priority,
  };
}

function computeChecksum(a) {
  return checksum(stableStringify(definitionOf(a)));
}

/**
 * @param {object} spec { resourceId (required), amount (required > 0), namespace?,
 *   owner?, priority?, allocationId?, status?, metadata? }
 * @param {object} [opts] { idFactory, clock }
 */
function createAllocation(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.resourceId) throw new ResourceValidationError('allocation: "resourceId" is required');
  if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
    throw new ResourceValidationError('allocation: "amount" must be a positive number');
  }
  const now = clock();
  const a = {
    allocationId: spec.allocationId || idFactory(),
    resourceId: spec.resourceId,
    namespace: spec.namespace || 'default',
    owner: spec.owner != null ? spec.owner : 'default',
    amount: spec.amount,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    status: Object.values(STATUS).includes(spec.status) ? spec.status : STATUS.ACTIVE,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    releasedAt: spec.releasedAt != null ? spec.releasedAt : null,

    isActive() {
      return this.status === STATUS.ACTIVE;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    release(nowMs, preempted) {
      this.status = preempted ? STATUS.PREEMPTED : STATUS.RELEASED;
      this.releasedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    toModel() {
      return {
        allocationId: this.allocationId,
        resourceId: this.resourceId,
        namespace: this.namespace,
        owner: this.owner,
        amount: this.amount,
        priority: this.priority,
        status: this.status,
        metadata: { ...this.metadata },
        createdAt: this.createdAt,
        releasedAt: this.releasedAt,
        checksum: this.checksum,
      };
    },
    toPublic() {
      return this.toModel();
    },
  };
  a.checksum = spec.checksum || computeChecksum(a);
  return a;
}

function fromModel(model, opts = {}) {
  const a = createAllocation(model, opts);
  a.status = model.status || STATUS.ACTIVE;
  a.createdAt = model.createdAt;
  a.releasedAt = model.releasedAt != null ? model.releasedAt : null;
  a.checksum = model.checksum != null ? model.checksum : computeChecksum(a);
  return a;
}

module.exports = { createAllocation, fromModel, computeChecksum, STATUS };
