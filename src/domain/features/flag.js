'use strict';

/**
 * FeatureFlag (Phase 15.0 / ADR-029 §2) — PURE domain value object. A
 * provider-agnostic feature definition: default value, targeting constraints,
 * ordered rules, and a percentage rollout, plus a content checksum for integrity.
 * This is NOT LaunchDarkly/Unleash/Firebase Remote Config and NOT an
 * experimentation framework — it is a deterministic definition the evaluation
 * engine consumes.
 *
 * Fields: flagId, name, namespace, description, state, defaultValue, offValue,
 * rules, targeting, rollout, appVersion, platform, country, region, tenant,
 * environment, priority, metadata, createdAt, updatedAt, version, checksum.
 */

const { FeatureValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATE = Object.freeze({ ENABLED: 'enabled', DISABLED: 'disabled', ARCHIVED: 'archived' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `flg_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** Deterministic canonical JSON (recursively sorted keys) → stable across runs. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** The semantic fields that define a flag (excludes timestamps, version, checksum). */
function definitionOf(f) {
  return {
    name: f.name,
    namespace: f.namespace,
    description: f.description,
    state: f.state,
    defaultValue: f.defaultValue,
    offValue: f.offValue,
    rules: f.rules,
    targeting: f.targeting,
    rollout: f.rollout,
    appVersion: f.appVersion,
    platform: f.platform,
    country: f.country,
    region: f.region,
    tenant: f.tenant,
    environment: f.environment,
    priority: f.priority,
    metadata: f.metadata,
  };
}

function computeChecksum(f) {
  return checksum(stableStringify(definitionOf(f)));
}

function normalizeRules(rules) {
  if (rules == null) return [];
  if (!Array.isArray(rules)) throw new FeatureValidationError('flag: "rules" must be an array');
  return rules.map((r, i) => ({
    id: r.id || `r${i}`,
    priority: typeof r.priority === 'number' ? r.priority : 0,
    when: { ...(r.when || {}) },
    value: r.value,
    rollout: r.rollout ? { ...r.rollout } : null,
  }));
}

/**
 * @param {object} spec { name (required), namespace?, description?, state?/enabled?,
 *   defaultValue?, offValue?, rules?, targeting?, rollout?, appVersion?, platform?,
 *   country?, region?, tenant?, environment?, priority?, metadata?, flagId?, version? }
 * @param {object} [opts] { idFactory, clock }
 */
function createFlag(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.name || typeof spec.name !== 'string') {
    throw new FeatureValidationError('flag: "name" is required');
  }
  if (spec.rollout != null) {
    const p = spec.rollout.percentage;
    if (typeof p !== 'number' || p < 0 || p > 100) {
      throw new FeatureValidationError('flag: rollout.percentage must be a number in [0,100]');
    }
  }
  const now = clock();
  const state = Object.values(STATE).includes(spec.state)
    ? spec.state
    : spec.enabled === false
      ? STATE.DISABLED
      : STATE.ENABLED;
  const flag = {
    flagId: spec.flagId || idFactory(),
    name: spec.name,
    namespace: spec.namespace || 'default',
    description: spec.description || '',
    state,
    defaultValue: spec.defaultValue !== undefined ? spec.defaultValue : true,
    offValue: spec.offValue !== undefined ? spec.offValue : false,
    rules: normalizeRules(spec.rules),
    targeting: spec.targeting ? { ...spec.targeting } : null,
    rollout: spec.rollout
      ? {
          percentage: spec.rollout.percentage,
          salt: spec.rollout.salt || null,
          attribute: spec.rollout.attribute || null,
        }
      : null,
    appVersion: spec.appVersion != null ? spec.appVersion : null,
    platform: spec.platform != null ? spec.platform : null,
    country: spec.country != null ? spec.country : null,
    region: spec.region != null ? spec.region : null,
    tenant: spec.tenant != null ? spec.tenant : null,
    environment: spec.environment != null ? spec.environment : null,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    isEnabled() {
      return this.state === STATE.ENABLED;
    },
    isArchived() {
      return this.state === STATE.ARCHIVED;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    _bump(now2) {
      this.version += 1;
      this.updatedAt = typeof now2 === 'number' ? now2 : clock();
      this.checksum = computeChecksum(this);
      return this;
    },
    enable(now2) {
      this.state = STATE.ENABLED;
      return this._bump(now2);
    },
    disable(now2) {
      this.state = STATE.DISABLED;
      return this._bump(now2);
    },
    /** Apply an additive patch of definition fields, then bump version + checksum. */
    applyUpdate(patch = {}, now2) {
      const allowed = [
        'description',
        'defaultValue',
        'offValue',
        'targeting',
        'appVersion',
        'platform',
        'country',
        'region',
        'tenant',
        'environment',
        'priority',
        'metadata',
      ];
      for (const k of allowed) {
        if (patch[k] !== undefined)
          this[k] =
            patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])
              ? { ...patch[k] }
              : patch[k];
      }
      if (patch.rules !== undefined) this.rules = normalizeRules(patch.rules);
      if (patch.rollout !== undefined) {
        if (patch.rollout === null) this.rollout = null;
        else {
          const p = patch.rollout.percentage;
          if (typeof p !== 'number' || p < 0 || p > 100) {
            throw new FeatureValidationError('flag: rollout.percentage must be in [0,100]');
          }
          this.rollout = {
            percentage: p,
            salt: patch.rollout.salt || null,
            attribute: patch.rollout.attribute || null,
          };
        }
      }
      if (patch.state !== undefined && Object.values(STATE).includes(patch.state)) {
        this.state = patch.state;
      }
      return this._bump(now2);
    },
    toModel() {
      return {
        flagId: this.flagId,
        name: this.name,
        namespace: this.namespace,
        description: this.description,
        state: this.state,
        defaultValue: this.defaultValue,
        offValue: this.offValue,
        rules: this.rules.map((r) => ({
          ...r,
          when: { ...r.when },
          rollout: r.rollout ? { ...r.rollout } : null,
        })),
        targeting: this.targeting ? { ...this.targeting } : null,
        rollout: this.rollout ? { ...this.rollout } : null,
        appVersion: this.appVersion,
        platform: this.platform,
        country: this.country,
        region: this.region,
        tenant: this.tenant,
        environment: this.environment,
        priority: this.priority,
        metadata: { ...this.metadata },
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        version: this.version,
        checksum: this.checksum,
      };
    },
    /** Flags are configuration, not secrets — the public view is the full model. */
    toPublic() {
      return this.toModel();
    },
  };
  flag.checksum = spec.checksum || computeChecksum(flag);
  return flag;
}

/** Rehydrate a flag from a persisted model (preserves stored checksum + timestamps). */
function fromModel(model, opts = {}) {
  const f = createFlag(model, opts);
  f.createdAt = model.createdAt;
  f.updatedAt = model.updatedAt;
  f.version = model.version;
  f.state = model.state;
  f.checksum = model.checksum != null ? model.checksum : computeChecksum(f);
  return f;
}

module.exports = { createFlag, fromModel, computeChecksum, stableStringify, STATE };
