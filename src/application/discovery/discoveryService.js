'use strict';

/**
 * Service Discovery Service (Phase 15.5 / ADR-034) — the Service Discovery Kernel.
 * Platform-wide, deterministic registration, discovery, capability lookup, health-
 * aware endpoint selection, and service metadata management. This is NOT Consul/
 * etcd/Kubernetes/DNS — those are provider extension points.
 *
 * Providers store service definitions; ALL behavior lives here + in the pure
 * selection domain: deterministic registration, capability lookup, version-aware
 * discovery, health-aware selection, priority + weight ordering, metadata
 * filtering, endpoint verification, discovery explanation, and a provider cache.
 * Events flow ONLY through the EventPublisher port. Deterministic: injected clock.
 * Per-service mutations are atomic via a serialization mutex.
 */

const { createService, fromModel, HEALTH } = require('../../domain/discovery/service');
const { filter: filterServices, selectOne } = require('../../domain/discovery/selection');
const { DISCOVERY_EVENTS, createDiscoveryEvent } = require('../../domain/discovery/events');
const { DiscoveryValidationError, ServiceNotFoundError } = require('../../domain/discovery/errors');
const { assertProvider } = require('./providerPort');
const { createDiscoveryCache } = require('./cache');
const { createNullPublisher } = require('../shared/eventPublisher');

function createDiscoveryService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const cache = deps.cache || createDiscoveryCache({ maxNamespaces: deps.cacheMaxNamespaces });

  const _index = new Map(); // namespace -> Map(serviceId -> { serviceName, healthStatus })
  function _indexSet(ns, id, serviceName, healthStatus) {
    if (!_index.has(ns)) _index.set(ns, new Map());
    _index.get(ns).set(id, { serviceName, healthStatus });
  }
  function _indexRemove(ns, id) {
    const m = _index.get(ns);
    if (m) m.delete(id);
  }
  function _countInstances() {
    let n = 0;
    for (const m of _index.values()) n += m.size;
    return n;
  }
  function _countServices() {
    const names = new Set();
    for (const m of _index.values()) for (const v of m.values()) names.add(`${v.serviceName}`);
    return names.size;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({ services: () => _countServices(), instances: () => _countInstances() });
  }

  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, ns, id) {
    _lifecycle.push({ type, namespace: ns, id, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  const _locks = new Map();
  function _withLock(key, fn) {
    const prev = _locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  function _emit(type, payload) {
    try {
      const event = createDiscoveryEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('discovery: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('discovery: could not build event', e.message);
    }
  }

  async function _safe(fn) {
    try {
      return await fn();
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }

  async function _loadServices(namespace) {
    const cached = cache.get(namespace);
    if (cached !== undefined) {
      if (metrics) metrics.recordCacheHit();
      return cached;
    }
    if (metrics) metrics.recordCacheMiss();
    const services = await _safe(() => provider.listServices(namespace));
    cache.set(namespace, services);
    return services;
  }

  // ── §1 register (upsert an instance) ──────────────────────────────────────────
  function register(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const service = createService({ ...spec, namespace }, { clock, idFactory: idOpts.idFactory });
      const id = service.serviceId;
      return _withLock(`${namespace}::${id}`, async () => {
        const existing = await _safe(() => provider.getService(namespace, id));
        await _safe(() => provider.putService(namespace, service.toModel()));
        cache.invalidate(namespace);
        const prevHealth = existing ? existing.healthStatus : null;
        _indexSet(namespace, id, service.serviceName, service.healthStatus);
        if (existing && prevHealth !== service.healthStatus) {
          if (metrics) metrics.recordHealthChange();
        }
        _recordLifecycle(existing ? 'updated' : 'registered', namespace, id);
        _emit(existing ? DISCOVERY_EVENTS.SERVICE_UPDATED : DISCOVERY_EVENTS.SERVICE_REGISTERED, {
          serviceId: id,
          namespace,
          serviceName: service.serviceName,
          instanceId: service.instanceId,
          version: service.version,
          healthStatus: service.healthStatus,
        });
        if (service.healthStatus === HEALTH.FAILED) {
          if (metrics) metrics.recordUnavailable();
          _emit(DISCOVERY_EVENTS.SERVICE_UNAVAILABLE, {
            serviceId: id,
            namespace,
            serviceName: service.serviceName,
            instanceId: service.instanceId,
          });
        }
        return service.toPublic();
      });
    })();
  }

  function _query(spec) {
    return {
      serviceName: spec.serviceName,
      version: spec.version,
      capabilities: spec.capabilities,
      tags: spec.tags,
      metadata: spec.metadata,
      healthyOnly: Boolean(spec.healthyOnly),
    };
  }

  // ── §1 discover (all matching instances, ordered) ──────────────────────────────
  function discover(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const start = clock();
      const services = await _loadServices(namespace);
      const query = _query(spec);
      const candidates = filterServices(services, query);
      if (metrics) {
        metrics.recordDiscovery();
        metrics.recordLatency(clock() - start);
      }
      return {
        namespace,
        query,
        count: candidates.length,
        candidates: candidates.map((c) => ({ ...c })),
      };
    })();
  }

  // ── §1 resolve (one health-aware, weighted instance) ────────────────────────────
  function resolve(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      if (!spec.serviceName)
        throw new DiscoveryValidationError('discovery: resolve requires serviceName');
      const start = clock();
      const services = await _loadServices(namespace);
      const query = { ..._query(spec), excludeFailed: true };
      const candidates = filterServices(services, query);
      const selection = selectOne(candidates, { serviceName: spec.serviceName, key: spec.key });
      if (metrics) {
        metrics.recordDiscovery();
        metrics.recordResolution();
        metrics.recordLatency(clock() - start);
      }
      if (!selection.selected) {
        if (metrics) metrics.recordUnavailable();
        _emit(DISCOVERY_EVENTS.SERVICE_UNAVAILABLE, { namespace, serviceName: spec.serviceName });
        throw new ServiceNotFoundError(
          `discovery: no available instance for "${spec.serviceName}" in "${namespace}"`
        );
      }
      _emit(DISCOVERY_EVENTS.SERVICE_RESOLVED, {
        namespace,
        serviceName: spec.serviceName,
        serviceId: selection.selected.serviceId,
        instanceId: selection.selected.instanceId,
        endpoint: selection.selected.endpoint,
      });
      return {
        namespace,
        selected: { ...selection.selected },
        explanation: {
          reason: selection.reason,
          candidateCount: selection.candidateCount,
          tierSize: selection.tierSize,
          priority: selection.priority,
          bucket: selection.bucket,
          totalWeight: selection.totalWeight,
        },
      };
    })();
  }

  // ── §1 list ──────────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const services = await _safe(() => provider.listServices(namespace));
      return services.map((s) => ({ ...s }));
    })();
  }

  // ── §1/§9 verify (endpoint + checksum integrity) ────────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const services = await _safe(() => provider.listServices(namespace));
      for (const model of services) {
        const svc = fromModel(model, { clock });
        if (!svc.verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ serviceId: model.serviceId, reason: 'checksum mismatch' });
        } else if (!svc.verifyEndpoint()) {
          issues.push({ serviceId: model.serviceId, reason: 'endpoint integrity failed' });
        }
      }
      if (metrics) metrics.recordVerification();
      const result = { ok: issues.length === 0, issues };
      _emit(DISCOVERY_EVENTS.DISCOVERY_VERIFIED, {
        namespace,
        ok: result.ok,
        issueCount: issues.length,
      });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      services: _countServices(),
      instances: _countInstances(),
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function deregister(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.serviceId;
    return _withLock(`${namespace}::${id}`, async () => {
      const removed = await _safe(() => provider.removeService(namespace, id));
      _indexRemove(namespace, id);
      cache.invalidate(namespace);
      if (removed) _recordLifecycle('deregistered', namespace, id);
      return Boolean(removed);
    });
  }
  async function snapshotService(namespace, serviceId) {
    const m = await _safe(() => provider.getService(namespace, serviceId));
    return m ? _deepFreeze(fromModel(m, { clock }).toPublic()) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      services: _countServices(),
      instances: (_index.get(namespace) || new Map()).size,
      totalInstances: _countInstances(),
      namespaces: _index.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    register,
    discover,
    resolve,
    list,
    verify,
    health,
    // additive helpers
    deregister,
    snapshotService,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createDiscoveryService };
