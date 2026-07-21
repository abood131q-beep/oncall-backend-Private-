'use strict';

/**
 * Tenant (Phase 15.9 / ADR-038 §2) — PURE domain value object. A provider-agnostic
 * tenant definition: identity, status, isolation level, configuration/policy/owner
 * references, capabilities, and labels, plus a content checksum for integrity. This
 * is NOT Kubernetes namespaces / IAM / database schemas — it is a deterministic
 * definition the tenancy engine consumes.
 *
 * Fields: tenantId, namespace, tenantName, tenantStatus, isolationLevel, configRef,
 * policyRef, ownerRef, metadata, labels, capabilities, version, checksum, createdAt,
 * updatedAt. The checksum covers the whole definition INCLUDING status, so a
 * lifecycle transition changes the checksum (and auto-invalidates cached contexts).
 */

const { TenancyValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
});
const ISOLATION = Object.freeze({ STRICT: 'strict', SHARED: 'shared', DEDICATED: 'dedicated' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `tnt_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(t) {
  return {
    tenantName: t.tenantName,
    namespace: t.namespace,
    tenantStatus: t.tenantStatus,
    isolationLevel: t.isolationLevel,
    configRef: t.configRef,
    policyRef: t.policyRef,
    ownerRef: t.ownerRef,
    metadata: t.metadata,
    labels: t.labels,
    capabilities: [...t.capabilities].sort(),
  };
}

function computeChecksum(t) {
  return checksum(stableStringify(definitionOf(t)));
}

/**
 * @param {object} spec { tenantName (required), namespace?, tenantStatus?,
 *   isolationLevel?, configRef?, policyRef?, ownerRef?, metadata?, labels?,
 *   capabilities?, tenantId?, version? }
 * @param {object} [opts] { idFactory, clock }
 */
function createTenant(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.tenantName || typeof spec.tenantName !== 'string') {
    throw new TenancyValidationError('tenant: "tenantName" is required');
  }
  const isolationLevel = spec.isolationLevel || ISOLATION.STRICT;
  if (!Object.values(ISOLATION).includes(isolationLevel)) {
    throw new TenancyValidationError(`tenant: unknown isolationLevel "${isolationLevel}"`);
  }
  const now = clock();
  const t = {
    tenantId: spec.tenantId || idFactory(),
    namespace: spec.namespace || 'default',
    tenantName: spec.tenantName,
    tenantStatus: Object.values(STATUS).includes(spec.tenantStatus)
      ? spec.tenantStatus
      : STATUS.PENDING,
    isolationLevel,
    configRef: spec.configRef != null ? spec.configRef : null,
    policyRef: spec.policyRef != null ? spec.policyRef : null,
    ownerRef: spec.ownerRef != null ? spec.ownerRef : null,
    metadata: { ...(spec.metadata || {}) },
    labels: { ...(spec.labels || {}) },
    capabilities: Array.isArray(spec.capabilities) ? [...spec.capabilities] : [],
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    isActive() {
      return this.tenantStatus === STATUS.ACTIVE;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    _bump(nowMs) {
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      this.checksum = computeChecksum(this);
      return this;
    },
    activate(nowMs) {
      this.tenantStatus = STATUS.ACTIVE;
      return this._bump(nowMs);
    },
    deactivate(nowMs) {
      this.tenantStatus = STATUS.INACTIVE;
      return this._bump(nowMs);
    },
    applyUpdate(patch = {}, nowMs) {
      for (const k of ['isolationLevel', 'configRef', 'policyRef', 'ownerRef']) {
        if (patch[k] !== undefined) this[k] = patch[k];
      }
      if (patch.metadata !== undefined) this.metadata = { ...patch.metadata };
      if (patch.labels !== undefined) this.labels = { ...patch.labels };
      if (patch.capabilities !== undefined) this.capabilities = [...patch.capabilities];
      if (patch.tenantStatus !== undefined && Object.values(STATUS).includes(patch.tenantStatus)) {
        this.tenantStatus = patch.tenantStatus;
      }
      return this._bump(nowMs);
    },
    toModel() {
      return {
        tenantId: this.tenantId,
        namespace: this.namespace,
        tenantName: this.tenantName,
        tenantStatus: this.tenantStatus,
        isolationLevel: this.isolationLevel,
        configRef: this.configRef,
        policyRef: this.policyRef,
        ownerRef: this.ownerRef,
        metadata: { ...this.metadata },
        labels: { ...this.labels },
        capabilities: [...this.capabilities],
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
  t.checksum = spec.checksum || computeChecksum(t);
  return t;
}

function fromModel(model, opts = {}) {
  const t = createTenant(model, opts);
  t.createdAt = model.createdAt;
  t.updatedAt = model.updatedAt;
  t.version = model.version;
  t.tenantStatus = model.tenantStatus || STATUS.PENDING;
  t.checksum = model.checksum != null ? model.checksum : computeChecksum(t);
  return t;
}

module.exports = { createTenant, fromModel, computeChecksum, stableStringify, STATUS, ISOLATION };
