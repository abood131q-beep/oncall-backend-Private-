'use strict';

/**
 * Route (Phase 15.6 / ADR-035 §2) — PURE domain value object. A provider-agnostic
 * gateway route: method + path → target service/endpoint, with policies, a
 * middleware chain, auth + rate-limit requirements, and a content checksum for
 * integrity. This is NOT Kong/Envoy/NGINX and NOT an HTTP server — it is a
 * deterministic routing definition the gateway engine consumes.
 *
 * Fields: routeId, namespace, method, path, version, targetService, targetEndpoint,
 * policies, middlewareChain, authRequired, rateLimitPolicy, timeout, priority,
 * metadata, checksum, createdAt, updatedAt.
 */

const { GatewayValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']);

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `rt_${Date.now().toString(36)}_${_seq.toString(36)}`;
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
    method: r.method,
    path: r.path,
    version: r.version,
    targetService: r.targetService,
    targetEndpoint: r.targetEndpoint,
    policies: r.policies,
    middlewareChain: r.middlewareChain,
    authRequired: r.authRequired,
    rateLimitPolicy: r.rateLimitPolicy,
    timeout: r.timeout,
    priority: r.priority,
    metadata: r.metadata,
  };
}

function computeChecksum(r) {
  return checksum(stableStringify(definitionOf(r)));
}

/**
 * @param {object} spec { method (required), path (required, starts with /),
 *   targetService? | targetEndpoint? (one required), namespace?, version?, policies?,
 *   middlewareChain?, authRequired?, rateLimitPolicy?, timeout?, priority?, metadata?,
 *   routeId? }
 * @param {object} [opts] { idFactory, clock }
 */
function createRoute(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  const method = (spec.method || '').toUpperCase();
  if (!method || !METHODS.has(method)) {
    throw new GatewayValidationError(`route: "method" must be one of ${[...METHODS].join(', ')}`);
  }
  if (!spec.path || typeof spec.path !== 'string' || spec.path[0] !== '/') {
    throw new GatewayValidationError('route: "path" is required and must start with "/"');
  }
  if (!spec.targetService && !spec.targetEndpoint) {
    throw new GatewayValidationError('route: a "targetService" or "targetEndpoint" is required');
  }
  const now = clock();
  const r = {
    routeId: spec.routeId || idFactory(),
    namespace: spec.namespace || 'default',
    method,
    path: spec.path,
    version: spec.version != null ? String(spec.version) : '*',
    targetService: spec.targetService != null ? spec.targetService : null,
    targetEndpoint: spec.targetEndpoint != null ? spec.targetEndpoint : null,
    policies: Array.isArray(spec.policies) ? [...spec.policies] : [],
    middlewareChain: Array.isArray(spec.middlewareChain) ? [...spec.middlewareChain] : [],
    authRequired: Boolean(spec.authRequired),
    rateLimitPolicy: spec.rateLimitPolicy != null ? spec.rateLimitPolicy : null,
    timeout: spec.timeout != null ? spec.timeout : null,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    metadata: { ...(spec.metadata || {}) },
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,

    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    applyUpdate(patch = {}, nowMs) {
      const allowed = [
        'method',
        'path',
        'version',
        'targetService',
        'targetEndpoint',
        'authRequired',
        'rateLimitPolicy',
        'timeout',
        'priority',
      ];
      for (const k of allowed) if (patch[k] !== undefined) this[k] = patch[k];
      if (patch.method !== undefined) this.method = String(patch.method).toUpperCase();
      if (patch.policies !== undefined) this.policies = [...patch.policies];
      if (patch.middlewareChain !== undefined) this.middlewareChain = [...patch.middlewareChain];
      if (patch.metadata !== undefined) this.metadata = { ...patch.metadata };
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.checksum = computeChecksum(this);
      return this;
    },
    toModel() {
      return {
        routeId: this.routeId,
        namespace: this.namespace,
        method: this.method,
        path: this.path,
        version: this.version,
        targetService: this.targetService,
        targetEndpoint: this.targetEndpoint,
        policies: [...this.policies],
        middlewareChain: [...this.middlewareChain],
        authRequired: this.authRequired,
        rateLimitPolicy: this.rateLimitPolicy,
        timeout: this.timeout,
        priority: this.priority,
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
  r.checksum = spec.checksum || computeChecksum(r);
  return r;
}

function fromModel(model, opts = {}) {
  const r = createRoute(model, opts);
  r.createdAt = model.createdAt;
  r.updatedAt = model.updatedAt;
  r.checksum = model.checksum != null ? model.checksum : computeChecksum(r);
  return r;
}

module.exports = { createRoute, fromModel, computeChecksum, stableStringify, METHODS };
