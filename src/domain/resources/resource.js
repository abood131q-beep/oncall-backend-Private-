'use strict';

/**
 * Resource (Phase 15.10 / ADR-039 §2) — PURE domain value object. A provider-
 * agnostic managed resource with capacity accounting: capacity, allocated,
 * available, quota (per-owner cap), reservation (headroom kept unallocatable), and
 * a content checksum over the DEFINITION. This is NOT Kubernetes ResourceQuota /
 * cgroups / Docker limits — it is a deterministic definition the engine governs.
 *
 * Fields: resourceId, namespace, resourceType, owner, capacity, allocated,
 * available, quota, reservation, priority, status, labels, metadata, version,
 * checksum, createdAt, updatedAt. The checksum covers the definition (type/owner/
 * capacity/quota/reservation/priority/labels/metadata) but NOT the volatile
 * allocated/available/status/timestamps.
 */

const { ResourceValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATUS = Object.freeze({ ACTIVE: 'active', EXHAUSTED: 'exhausted', RETIRED: 'retired' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `res_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(r) {
  return {
    namespace: r.namespace,
    resourceType: r.resourceType,
    owner: r.owner,
    capacity: r.capacity,
    quota: r.quota,
    reservation: r.reservation,
    priority: r.priority,
    labels: r.labels,
    metadata: r.metadata,
  };
}

function computeChecksum(r) {
  return checksum(stableStringify(definitionOf(r)));
}

/**
 * @param {object} spec { resourceType (required), capacity (required > 0), namespace?,
 *   owner?, allocated?, quota?, reservation?, priority?, labels?, metadata?,
 *   resourceId?, status? }
 * @param {object} [opts] { idFactory, clock }
 */
function createResource(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.resourceType || typeof spec.resourceType !== 'string') {
    throw new ResourceValidationError('resource: "resourceType" is required');
  }
  if (!Number.isFinite(spec.capacity) || spec.capacity <= 0) {
    throw new ResourceValidationError('resource: "capacity" must be a positive number');
  }
  const reservation = spec.reservation == null ? 0 : Number(spec.reservation);
  if (!Number.isFinite(reservation) || reservation < 0 || reservation > spec.capacity) {
    throw new ResourceValidationError('resource: "reservation" must be in [0, capacity]');
  }
  if (spec.quota != null && (!Number.isFinite(spec.quota) || spec.quota < 0)) {
    throw new ResourceValidationError('resource: "quota" must be a non-negative number');
  }
  const now = clock();
  const allocated = spec.allocated || 0;
  const r = {
    resourceId: spec.resourceId || idFactory(),
    namespace: spec.namespace || 'default',
    resourceType: spec.resourceType,
    owner: spec.owner != null ? spec.owner : null,
    capacity: spec.capacity,
    allocated,
    quota: spec.quota != null ? Number(spec.quota) : null,
    reservation,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    status: Object.values(STATUS).includes(spec.status) ? spec.status : STATUS.ACTIVE,
    labels: { ...(spec.labels || {}) },
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    /** Capacity a general request may draw from (reservation is kept as headroom). */
    allocatable() {
      return this.capacity - this.reservation;
    },
    availableAmount() {
      return this.capacity - this.allocated;
    },
    utilization() {
      return this.capacity > 0 ? this.allocated / this.capacity : 0;
    },
    canAllocate(amount) {
      return this.allocated + amount <= this.allocatable();
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    applyAllocate(amount, nowMs) {
      this.allocated += amount;
      this.status = this.availableAmount() <= 0 ? STATUS.EXHAUSTED : STATUS.ACTIVE;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    applyRelease(amount, nowMs) {
      this.allocated = Math.max(0, this.allocated - amount);
      this.status = this.availableAmount() <= 0 ? STATUS.EXHAUSTED : STATUS.ACTIVE;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    toModel() {
      return {
        resourceId: this.resourceId,
        namespace: this.namespace,
        resourceType: this.resourceType,
        owner: this.owner,
        capacity: this.capacity,
        allocated: this.allocated,
        available: this.availableAmount(),
        quota: this.quota,
        reservation: this.reservation,
        priority: this.priority,
        status: this.status,
        labels: { ...this.labels },
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
  r.checksum = spec.checksum || computeChecksum(r);
  return r;
}

function fromModel(model, opts = {}) {
  const r = createResource(model, opts);
  r.allocated = model.allocated || 0;
  r.status = model.status || STATUS.ACTIVE;
  r.createdAt = model.createdAt;
  r.updatedAt = model.updatedAt;
  r.version = model.version;
  r.checksum = model.checksum != null ? model.checksum : computeChecksum(r);
  return r;
}

module.exports = { createResource, fromModel, computeChecksum, stableStringify, STATUS };
