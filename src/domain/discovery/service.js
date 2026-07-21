'use strict';

/**
 * Service (Phase 15.5 / ADR-034 §2) — PURE domain value object. A registered
 * service instance: identity, endpoint, capabilities, health, and routing weights,
 * plus a content checksum over its definition (endpoint integrity). This is NOT
 * Consul/etcd/Kubernetes/DNS — those are provider extension points.
 *
 * Fields: serviceId, namespace, serviceName, version, instanceId, endpoint,
 * protocol, capabilities, tags, healthStatus, priority, weight, metadata, checksum,
 * createdAt, updatedAt. The checksum covers the definition (identity + endpoint +
 * capabilities + routing) but NOT the volatile healthStatus/timestamps.
 */

const { DiscoveryValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});
const HEALTH_SET = new Set(Object.values(HEALTH));

let _seq = 0;
function defaultId(prefix) {
  _seq = (_seq + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(s) {
  return {
    namespace: s.namespace,
    serviceName: s.serviceName,
    version: s.version,
    instanceId: s.instanceId,
    endpoint: s.endpoint,
    protocol: s.protocol,
    capabilities: [...s.capabilities].sort(),
    tags: [...s.tags].sort(),
    priority: s.priority,
    weight: s.weight,
    metadata: s.metadata,
  };
}

function computeChecksum(s) {
  return checksum(stableStringify(definitionOf(s)));
}

/**
 * @param {object} spec { serviceName (required), endpoint (required), namespace?,
 *   version?, instanceId?, protocol?, capabilities?, tags?, healthStatus?,
 *   priority?, weight?, metadata?, serviceId? }
 * @param {object} [opts] { idFactory, clock }
 */
function createService(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || null;
  const clock = opts.clock || (() => Date.now());
  if (!spec.serviceName || typeof spec.serviceName !== 'string') {
    throw new DiscoveryValidationError('service: "serviceName" is required');
  }
  if (!spec.endpoint || typeof spec.endpoint !== 'string') {
    throw new DiscoveryValidationError('service: "endpoint" is required');
  }
  if (
    spec.metadata != null &&
    (typeof spec.metadata !== 'object' || Array.isArray(spec.metadata))
  ) {
    throw new DiscoveryValidationError('service: "metadata" must be an object');
  }
  if (spec.weight != null && (!Number.isFinite(spec.weight) || spec.weight < 0)) {
    throw new DiscoveryValidationError('service: "weight" must be a non-negative number');
  }
  const now = clock();
  const mkId = (prefix) => (idFactory ? idFactory(prefix) : defaultId(prefix));
  const s = {
    serviceId: spec.serviceId || mkId('svc'),
    namespace: spec.namespace || 'default',
    serviceName: spec.serviceName,
    version: spec.version != null ? String(spec.version) : '0.0.0',
    instanceId: spec.instanceId || mkId('ins'),
    endpoint: spec.endpoint,
    protocol: spec.protocol || 'http',
    capabilities: Array.isArray(spec.capabilities) ? [...spec.capabilities] : [],
    tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
    healthStatus: HEALTH_SET.has(spec.healthStatus) ? spec.healthStatus : HEALTH.UNKNOWN,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    weight: typeof spec.weight === 'number' ? spec.weight : 1,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,

    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    /** Endpoint integrity: a well-formed, non-empty endpoint + matching checksum. */
    verifyEndpoint() {
      return typeof this.endpoint === 'string' && this.endpoint.length > 0 && this.verifyChecksum();
    },
    setHealth(status, nowMs) {
      this.healthStatus = HEALTH_SET.has(status) ? status : HEALTH.UNKNOWN;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      return this;
    },
    /** Apply an additive definition update, then refresh checksum + timestamp. */
    applyUpdate(patch = {}, nowMs) {
      for (const k of ['endpoint', 'protocol', 'version', 'priority', 'weight']) {
        if (patch[k] !== undefined) this[k] = patch[k];
      }
      if (patch.capabilities !== undefined) this.capabilities = [...patch.capabilities];
      if (patch.tags !== undefined) this.tags = [...patch.tags];
      if (patch.metadata !== undefined) this.metadata = { ...patch.metadata };
      if (patch.healthStatus !== undefined) {
        this.healthStatus = HEALTH_SET.has(patch.healthStatus)
          ? patch.healthStatus
          : this.healthStatus;
      }
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.checksum = computeChecksum(this);
      return this;
    },
    toModel() {
      return {
        serviceId: this.serviceId,
        namespace: this.namespace,
        serviceName: this.serviceName,
        version: this.version,
        instanceId: this.instanceId,
        endpoint: this.endpoint,
        protocol: this.protocol,
        capabilities: [...this.capabilities],
        tags: [...this.tags],
        healthStatus: this.healthStatus,
        priority: this.priority,
        weight: this.weight,
        metadata: { ...this.metadata },
        checksum: this.checksum,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
      };
    },
    toPublic() {
      return this.toModel();
    },
  };
  s.checksum = spec.checksum || computeChecksum(s);
  return s;
}

function fromModel(model, opts = {}) {
  const s = createService(model, opts);
  s.createdAt = model.createdAt;
  s.updatedAt = model.updatedAt;
  s.healthStatus = model.healthStatus || HEALTH.UNKNOWN;
  s.checksum = model.checksum != null ? model.checksum : computeChecksum(s);
  return s;
}

module.exports = { createService, fromModel, computeChecksum, stableStringify, HEALTH };
