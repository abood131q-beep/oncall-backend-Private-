'use strict';

/**
 * Hosted Service Contract + Host Registry (Phase 16.3 / ADR-044 §2, §3).
 *
 * §2 Service contract — a hosted service exposes ONLY these nine methods:
 *   id() name() version() dependencies() start() stop() health() verify() metadata()
 * No service may access another service directly; all interaction is through declared
 * interfaces (the host injects only the context slices a service declares in
 * metadata().needs, and dependency IDs are the only sibling references a service names).
 *
 * §3 Registry — a per-host, closure-scoped registry (no globals, no singletons):
 *   register() unregister() resolve() list() verify()
 * detecting duplicate ids, missing services, and invalid contracts.
 */

const { ServiceContractError, DuplicateServiceError, ServiceNotFoundError } = require('./errors');

const CONTRACT_METHODS = Object.freeze([
  'id',
  'name',
  'version',
  'dependencies',
  'start',
  'stop',
  'health',
  'verify',
  'metadata',
]);

/** Validate a service against the §2 contract; throws ServiceContractError on any gap. */
function assertServiceContract(service) {
  if (!service || typeof service !== 'object') {
    throw new ServiceContractError('hosted service: must be an object implementing the contract');
  }
  for (const m of CONTRACT_METHODS) {
    if (typeof service[m] !== 'function') {
      throw new ServiceContractError(`hosted service: must implement ${m}()`);
    }
  }
  const id = service.id();
  if (!id || typeof id !== 'string') {
    throw new ServiceContractError('hosted service: id() must return a non-empty string');
  }
  const deps = service.dependencies();
  if (!Array.isArray(deps)) {
    throw new ServiceContractError(`hosted service "${id}": dependencies() must return an array`);
  }
  return service;
}

/** A lightweight, immutable descriptor derived from a validated service. */
function describe(service) {
  const meta = service.metadata() || {};
  return Object.freeze({
    id: service.id(),
    name: service.name(),
    version: service.version(),
    dependsOn: Object.freeze([...service.dependencies()]),
    ports: Object.freeze([]), // hosted services never inject sibling services directly
    needs: Object.freeze([...(meta.needs || [])]),
    metadata: Object.freeze({ ...meta }),
  });
}

function createHostRegistry() {
  const order = []; // registration order (ids)
  const byId = new Map(); // id -> { service, descriptor }

  function register(service) {
    assertServiceContract(service);
    const id = service.id();
    if (byId.has(id)) {
      throw new DuplicateServiceError(`hostRegistry: service "${id}" already registered`);
    }
    const descriptor = describe(service);
    byId.set(id, { service, descriptor });
    order.push(id);
    return descriptor;
  }

  function unregister(id) {
    if (!byId.has(id)) return false;
    byId.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    return true;
  }

  function resolve(id) {
    const entry = byId.get(id);
    if (!entry) throw new ServiceNotFoundError(`hostRegistry: service "${id}" is not registered`);
    return entry;
  }

  function has(id) {
    return byId.has(id);
  }

  function list() {
    return order.map((id) => byId.get(id));
  }

  function descriptors() {
    return order.map((id) => byId.get(id).descriptor);
  }

  /** Structural verification: contracts re-checked + every declared dependency present. */
  function verify() {
    const issues = [];
    const known = new Set(order);
    for (const id of order) {
      const { service, descriptor } = byId.get(id);
      try {
        assertServiceContract(service);
      } catch (e) {
        issues.push({ service: id, reason: 'invalid contract', error: e.message });
      }
      for (const dep of descriptor.dependsOn) {
        if (!known.has(dep)) {
          issues.push({ service: id, reason: 'missing dependency', dependency: dep });
        }
      }
    }
    return { ok: issues.length === 0, count: order.length, issues };
  }

  return { register, unregister, resolve, has, list, descriptors, verify };
}

module.exports = { createHostRegistry, assertServiceContract, describe, CONTRACT_METHODS };
