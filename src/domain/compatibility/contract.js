'use strict';

/**
 * Contract (Phase 15.12 / ADR-041 §2) — PURE domain value object. A provider-
 * agnostic compatibility contract for a component: its current version, the versions
 * it supports, the capabilities it offers, its compatibility level, and its
 * deprecation status, plus a content checksum. This is NOT semver/npm/API-versioning
 * middleware/a migration framework — it is a deterministic definition the
 * compatibility engine evaluates.
 *
 * Fields: contractId, namespace, component, version, supportedVersions, capabilities,
 * compatibilityLevel, deprecationStatus, replacementContract, metadata, checksum,
 * createdAt, updatedAt.
 */

const { CompatibilityValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const LEVEL = Object.freeze({
  STRICT: 'strict',
  BACKWARD: 'backward',
  FORWARD: 'forward',
  FULL: 'full',
  NONE: 'none',
});
const LEVEL_SET = new Set(Object.values(LEVEL));

const DEPRECATION = Object.freeze({
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
  RETIRED: 'retired',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `ctr_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(c) {
  return {
    namespace: c.namespace,
    component: c.component,
    version: c.version,
    supportedVersions: [...c.supportedVersions].sort(),
    capabilities: [...c.capabilities].sort(),
    compatibilityLevel: c.compatibilityLevel,
    deprecationStatus: c.deprecationStatus,
    replacementContract: c.replacementContract,
    metadata: c.metadata,
  };
}

function computeChecksum(c) {
  return checksum(stableStringify(definitionOf(c)));
}

/**
 * @param {object} spec { component (required), version (required), namespace?,
 *   supportedVersions?, capabilities?, compatibilityLevel?, deprecationStatus?,
 *   replacementContract?, metadata?, contractId? }
 * @param {object} [opts] { idFactory, clock }
 */
function createContract(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.component || typeof spec.component !== 'string') {
    throw new CompatibilityValidationError('contract: "component" is required');
  }
  if (!spec.version || typeof spec.version !== 'string') {
    throw new CompatibilityValidationError('contract: "version" is required');
  }
  const compatibilityLevel = spec.compatibilityLevel || LEVEL.BACKWARD;
  if (!LEVEL_SET.has(compatibilityLevel)) {
    throw new CompatibilityValidationError(
      `contract: unknown compatibilityLevel "${compatibilityLevel}"`
    );
  }
  const now = clock();
  const c = {
    contractId: spec.contractId || idFactory(),
    namespace: spec.namespace || 'default',
    component: spec.component,
    version: spec.version,
    supportedVersions: Array.isArray(spec.supportedVersions)
      ? [...spec.supportedVersions]
      : [spec.version],
    capabilities: Array.isArray(spec.capabilities) ? [...spec.capabilities] : [],
    compatibilityLevel,
    deprecationStatus: Object.values(DEPRECATION).includes(spec.deprecationStatus)
      ? spec.deprecationStatus
      : DEPRECATION.ACTIVE,
    replacementContract: spec.replacementContract != null ? spec.replacementContract : null,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version_: spec.version_ || 1, // internal record version (distinct from contract semver)

    isDeprecated() {
      return this.deprecationStatus !== DEPRECATION.ACTIVE;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    deprecate(replacementContract, nowMs, retired) {
      this.deprecationStatus = retired ? DEPRECATION.RETIRED : DEPRECATION.DEPRECATED;
      if (replacementContract != null) this.replacementContract = replacementContract;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version_ += 1;
      this.checksum = computeChecksum(this);
      return this;
    },
    toModel() {
      return {
        contractId: this.contractId,
        namespace: this.namespace,
        component: this.component,
        version: this.version,
        supportedVersions: [...this.supportedVersions],
        capabilities: [...this.capabilities],
        compatibilityLevel: this.compatibilityLevel,
        deprecationStatus: this.deprecationStatus,
        replacementContract: this.replacementContract,
        metadata: { ...this.metadata },
        checksum: this.checksum,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        version_: this.version_,
      };
    },
    toPublic() {
      return this.toModel();
    },
  };
  c.checksum = spec.checksum || computeChecksum(c);
  return c;
}

function fromModel(model, opts = {}) {
  const c = createContract(model, opts);
  c.createdAt = model.createdAt;
  c.updatedAt = model.updatedAt;
  c.version_ = model.version_ || 1;
  c.deprecationStatus = model.deprecationStatus || DEPRECATION.ACTIVE;
  c.checksum = model.checksum != null ? model.checksum : computeChecksum(c);
  return c;
}

module.exports = {
  createContract,
  fromModel,
  computeChecksum,
  stableStringify,
  LEVEL,
  DEPRECATION,
};
