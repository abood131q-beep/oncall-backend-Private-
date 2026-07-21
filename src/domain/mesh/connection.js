'use strict';

/**
 * Connection (Phase 15.8 / ADR-037 §2) — PURE domain value object. A
 * provider-agnostic service-to-service connection definition: source →
 * destination, protocol, and the traffic / routing / security / retry policies
 * that govern invocations over it, plus a content checksum. This is NOT Istio/
 * Linkerd/Consul Connect and NOT a network proxy — it is a deterministic definition
 * the mesh engine consumes.
 *
 * Fields: connectionId, namespace, sourceService, destinationService, protocol,
 * trafficPolicy, routingPolicy, securityPolicy, retryPolicy, timeout, priority,
 * connectionState, metadata, version, checksum, createdAt, updatedAt. The checksum
 * covers the definition but NOT the volatile connectionState/timestamps.
 */

const { MeshValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const STATE = Object.freeze({
  REGISTERED: 'registered',
  ESTABLISHED: 'established',
  CLOSED: 'closed',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `con_${Date.now().toString(36)}_${_seq.toString(36)}`;
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
    sourceService: c.sourceService,
    destinationService: c.destinationService,
    protocol: c.protocol,
    trafficPolicy: c.trafficPolicy,
    routingPolicy: c.routingPolicy,
    securityPolicy: c.securityPolicy,
    retryPolicy: c.retryPolicy,
    timeout: c.timeout,
    priority: c.priority,
    metadata: c.metadata,
  };
}

function computeChecksum(c) {
  return checksum(stableStringify(definitionOf(c)));
}

/**
 * @param {object} spec { sourceService (required), destinationService (required),
 *   namespace?, protocol?, trafficPolicy?, routingPolicy?, securityPolicy?,
 *   retryPolicy?, timeout?, priority?, metadata?, connectionId?, connectionState? }
 * @param {object} [opts] { idFactory, clock }
 */
function createConnection(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.sourceService || typeof spec.sourceService !== 'string') {
    throw new MeshValidationError('connection: "sourceService" is required');
  }
  if (!spec.destinationService || typeof spec.destinationService !== 'string') {
    throw new MeshValidationError('connection: "destinationService" is required');
  }
  const now = clock();
  const c = {
    connectionId: spec.connectionId || idFactory(),
    namespace: spec.namespace || 'default',
    sourceService: spec.sourceService,
    destinationService: spec.destinationService,
    protocol: spec.protocol || 'grpc',
    trafficPolicy: spec.trafficPolicy ? { ...spec.trafficPolicy } : {},
    routingPolicy: spec.routingPolicy ? { ...spec.routingPolicy } : {},
    securityPolicy: spec.securityPolicy ? { ...spec.securityPolicy } : {},
    retryPolicy: spec.retryPolicy ? { ...spec.retryPolicy } : null,
    timeout: spec.timeout != null ? Number(spec.timeout) : null,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    connectionState: Object.values(STATE).includes(spec.connectionState)
      ? spec.connectionState
      : STATE.REGISTERED,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    isEstablished() {
      return this.connectionState === STATE.ESTABLISHED;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    establish(nowMs) {
      this.connectionState = STATE.ESTABLISHED;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    close(nowMs) {
      this.connectionState = STATE.CLOSED;
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    toModel() {
      return {
        connectionId: this.connectionId,
        namespace: this.namespace,
        sourceService: this.sourceService,
        destinationService: this.destinationService,
        protocol: this.protocol,
        trafficPolicy: { ...this.trafficPolicy },
        routingPolicy: { ...this.routingPolicy },
        securityPolicy: { ...this.securityPolicy },
        retryPolicy: this.retryPolicy ? { ...this.retryPolicy } : null,
        timeout: this.timeout,
        priority: this.priority,
        connectionState: this.connectionState,
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
  const c = createConnection(model, opts);
  c.createdAt = model.createdAt;
  c.updatedAt = model.updatedAt;
  c.version = model.version;
  c.connectionState = model.connectionState || STATE.REGISTERED;
  c.checksum = model.checksum != null ? model.checksum : computeChecksum(c);
  return c;
}

module.exports = { createConnection, fromModel, computeChecksum, stableStringify, STATE };
