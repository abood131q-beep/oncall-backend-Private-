'use strict';

/**
 * Secret (Phase 14.9 / ADR-028 §2) — PURE domain value object. Represents a
 * versioned, provider-agnostic secret: sensitive configuration or a credential.
 * This is NOT a password manager and NOT Vault/AWS/Azure/GCP — those are provider
 * extension points.
 *
 * Fields: secretId, name, namespace, version, value (PROTECTED), valueChecksum
 * (integrity fingerprint), metadata, tags, rotationPolicy, createdAt, updatedAt,
 * state. The plaintext value lives on the model for the authoritative store and
 * `resolve()` only; `toPublic()` redacts it. Deterministic transitions.
 */

const { SecretValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');
const { createRotationPolicy, policyFromModel } = require('./rotationPolicy');
const { redactModel } = require('./redaction');

const STATE = Object.freeze({ ACTIVE: 'active', DEPRECATED: 'deprecated', DELETED: 'deleted' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `sec_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** Deterministic integrity fingerprint of a value (sha256 hex). */
function valueChecksum(value) {
  return checksum(String(value));
}

/**
 * @param {object} spec { name (required), value (required), namespace?, secretId?,
 *   version?, metadata?, tags?, rotationPolicy?, createdAt?, updatedAt?, state? }
 * @param {object} [opts] { idFactory, clock }
 */
function createSecret(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.name || typeof spec.name !== 'string') {
    throw new SecretValidationError('secret: "name" is required');
  }
  if (spec.value == null || typeof spec.value !== 'string') {
    throw new SecretValidationError('secret: "value" is required and must be a string');
  }
  const now = clock();
  const secret = {
    secretId: spec.secretId || idFactory(),
    name: spec.name,
    namespace: spec.namespace || 'default',
    version: spec.version || 1,
    value: spec.value,
    valueChecksum: spec.valueChecksum || valueChecksum(spec.value),
    metadata: { ...(spec.metadata || {}) },
    tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
    rotationPolicy: spec.rotationPolicy
      ? policyFromModel(
          typeof spec.rotationPolicy.toModel === 'function'
            ? spec.rotationPolicy.toModel()
            : spec.rotationPolicy
        )
      : createRotationPolicy({}),
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    state: Object.values(STATE).includes(spec.state) ? spec.state : STATE.ACTIVE,

    isActive() {
      return this.state === STATE.ACTIVE;
    },
    isDeleted() {
      return this.state === STATE.DELETED;
    },
    /** Reveal the plaintext — the authoritative accessor used only by resolve(). */
    reveal() {
      return this.value;
    },
    /** Integrity check: the stored value must match its checksum. */
    verifyIntegrity() {
      return this.value != null && this.valueChecksum === valueChecksum(this.value);
    },
    /** Whether the rotation policy considers this secret due at `now`. */
    isDue(nowMs) {
      return this.rotationPolicy.isDue(this.updatedAt, nowMs);
    },
    /** Deterministic rotation: bump version, replace value + checksum + updatedAt. */
    rotate(newValue, nowMs) {
      if (newValue == null || typeof newValue !== 'string') {
        throw new SecretValidationError('secret: rotation value must be a string');
      }
      this.version += 1;
      this.value = newValue;
      this.valueChecksum = valueChecksum(newValue);
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.state = STATE.ACTIVE;
      return this;
    },
    deprecate(nowMs) {
      this.state = STATE.DEPRECATED;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    markDeleted(nowMs) {
      this.state = STATE.DELETED;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    /** Full model (includes plaintext value) — for the provider store only. */
    toModel() {
      return {
        secretId: this.secretId,
        name: this.name,
        namespace: this.namespace,
        version: this.version,
        value: this.value,
        valueChecksum: this.valueChecksum,
        metadata: { ...this.metadata },
        tags: [...this.tags],
        rotationPolicy: this.rotationPolicy.toModel(),
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        state: this.state,
      };
    },
    /** Safe view (value REDACTED) — for events, listings, SDK, and API responses. */
    toPublic() {
      return redactModel(this.toModel());
    },
  };
  return secret;
}

/** Rehydrate a secret entity from a persisted model. */
function fromModel(model, opts = {}) {
  const s = createSecret(model, opts);
  s.createdAt = model.createdAt;
  s.updatedAt = model.updatedAt;
  s.version = model.version;
  s.state = model.state;
  s.valueChecksum = model.valueChecksum || valueChecksum(model.value);
  return s;
}

module.exports = { createSecret, fromModel, valueChecksum, STATE };
