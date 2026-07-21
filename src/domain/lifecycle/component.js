'use strict';

/**
 * Component (Phase 15.11 / ADR-040 §2) — PURE domain value object. A managed unit in
 * the lifecycle graph: identity, type, dependencies, startup/shutdown priorities,
 * init + restart policies, and a lifecycle state, plus a content checksum over the
 * DEFINITION. This is NOT systemd/K8s Operators/Docker Compose/PM2 — it is a
 * deterministic definition the lifecycle engine orchestrates.
 *
 * Fields: componentId, namespace, componentType, lifecycleState, dependencies,
 * startupPriority, shutdownPriority, initializationPolicy, restartPolicy,
 * healthStatus, metadata, version, checksum, createdAt, updatedAt. The checksum
 * covers the definition but NOT the volatile lifecycleState/healthStatus/timestamps.
 */

const { LifecycleValidationError, TransitionError } = require('./errors');
const { checksum } = require('../extensions/integrity');
const { STATE, validTransition } = require('./states');

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `cmp_${Date.now().toString(36)}_${_seq.toString(36)}`;
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
    componentType: c.componentType,
    dependencies: [...c.dependencies].sort(),
    startupPriority: c.startupPriority,
    shutdownPriority: c.shutdownPriority,
    initializationPolicy: c.initializationPolicy,
    restartPolicy: c.restartPolicy,
    metadata: c.metadata,
  };
}

function computeChecksum(c) {
  return checksum(stableStringify(definitionOf(c)));
}

/**
 * @param {object} spec { componentType (required), componentId?, namespace?,
 *   dependencies?, startupPriority?, shutdownPriority?, initializationPolicy?,
 *   restartPolicy?, healthStatus?, metadata?, lifecycleState? }
 * @param {object} [opts] { idFactory, clock }
 */
function createComponent(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.componentType || typeof spec.componentType !== 'string') {
    throw new LifecycleValidationError('component: "componentType" is required');
  }
  if (spec.dependencies != null && !Array.isArray(spec.dependencies)) {
    throw new LifecycleValidationError('component: "dependencies" must be an array');
  }
  const now = clock();
  const c = {
    componentId: spec.componentId || idFactory(),
    namespace: spec.namespace || 'default',
    componentType: spec.componentType,
    lifecycleState: Object.values(STATE).includes(spec.lifecycleState)
      ? spec.lifecycleState
      : STATE.REGISTERED,
    dependencies: Array.isArray(spec.dependencies) ? [...spec.dependencies] : [],
    startupPriority: typeof spec.startupPriority === 'number' ? spec.startupPriority : 0,
    shutdownPriority: typeof spec.shutdownPriority === 'number' ? spec.shutdownPriority : 0,
    initializationPolicy: spec.initializationPolicy || 'eager',
    restartPolicy: spec.restartPolicy || 'on-failure',
    healthStatus: spec.healthStatus || 'unknown',
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    /** Validate + apply a state transition. Throws TransitionError if illegal. */
    transition(to, nowMs) {
      if (!validTransition(this.lifecycleState, to)) {
        throw new TransitionError(
          `component "${this.componentId}": illegal transition ${this.lifecycleState} → ${to}`
        );
      }
      this.lifecycleState = to;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    setHealth(status, nowMs) {
      this.healthStatus = status;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    toModel() {
      return {
        componentId: this.componentId,
        namespace: this.namespace,
        componentType: this.componentType,
        lifecycleState: this.lifecycleState,
        dependencies: [...this.dependencies],
        startupPriority: this.startupPriority,
        shutdownPriority: this.shutdownPriority,
        initializationPolicy: this.initializationPolicy,
        restartPolicy: this.restartPolicy,
        healthStatus: this.healthStatus,
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
  c.checksum = spec.checksum || computeChecksum(c);
  return c;
}

function fromModel(model, opts = {}) {
  const c = createComponent(model, opts);
  c.lifecycleState = model.lifecycleState || STATE.REGISTERED;
  c.healthStatus = model.healthStatus || 'unknown';
  c.createdAt = model.createdAt;
  c.updatedAt = model.updatedAt;
  c.version = model.version;
  c.checksum = model.checksum != null ? model.checksum : computeChecksum(c);
  return c;
}

module.exports = { createComponent, fromModel, computeChecksum, stableStringify, STATE };
