'use strict';

/**
 * Resource Management Service (Phase 15.10 / ADR-039) — the Resource Management
 * Kernel. Platform-wide, deterministic resource allocation, capacity governance,
 * quota orchestration, and lifecycle management. This is NOT Kubernetes
 * ResourceQuota / cgroups / Docker limits / cloud autoscaling — those are
 * infrastructure details.
 *
 * Providers persist resource definitions + allocation state; ALL behavior lives here
 * + in the pure domain: deterministic allocation, capacity tracking, reservation
 * management, quota enforcement, priority-based allocation with preemption, conflict
 * detection, lifecycle management, allocation history, verification, and resource
 * accounting. Events flow ONLY through the EventPublisher port. Deterministic:
 * injected clock. Allocations against one resource are atomic via a serialization
 * mutex, so capacity is never over-committed.
 */

const { createResource, fromModel: resourceFromModel } = require('../../domain/resources/resource');
const {
  createAllocation,
  fromModel: allocationFromModel,
} = require('../../domain/resources/allocation');
const { RESOURCE_EVENTS, createResourceEvent } = require('../../domain/resources/events');
const {
  ResourceValidationError,
  ResourceNotFoundError,
  QuotaExceededError,
  ResourceConflictError,
  IntegrityError,
} = require('../../domain/resources/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createResourceService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _resourceIndex = new Map(); // namespace -> Set(resourceId)
  const _stats = new Map(); // `${ns}::${resourceId}` -> { capacity, allocated }
  const _allocStatus = new Map(); // `${ns}::${allocationId}` -> status

  function _indexResource(ns, id) {
    if (!_resourceIndex.has(ns)) _resourceIndex.set(ns, new Set());
    _resourceIndex.get(ns).add(id);
  }
  function _setStats(ns, id, capacity, allocated) {
    _stats.set(`${ns}::${id}`, { capacity, allocated });
  }
  function _countResources() {
    let n = 0;
    for (const s of _resourceIndex.values()) n += s.size;
    return n;
  }
  function _countActiveAllocations() {
    let n = 0;
    for (const s of _allocStatus.values()) if (s === 'active') n += 1;
    return n;
  }
  function _utilization() {
    let cap = 0;
    let alloc = 0;
    for (const s of _stats.values()) {
      cap += s.capacity;
      alloc += s.allocated;
    }
    return cap > 0 ? alloc / cap : 0;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      resources: () => _countResources(),
      active: () => _countActiveAllocations(),
      utilization: () => _utilization(),
    });
  }

  const historyLimit = deps.historyLimit || 500;
  const _lifecycle = [];
  function _recordLifecycle(type, ns, id) {
    _lifecycle.push({ type, namespace: ns, id, at: clock() });
    if (_lifecycle.length > historyLimit) _lifecycle.shift();
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
      const event = createResourceEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('resources: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('resources: could not build event', e.message);
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

  const _fullKey = (ns, id) => `${ns}::${id}`;

  async function _resolveResource(namespace, resourceId) {
    const model = await _safe(() => provider.getResource(namespace, resourceId));
    if (!model) {
      throw new ResourceNotFoundError(
        `resources: resource "${resourceId}" not found in "${namespace}"`
      );
    }
    const resource = resourceFromModel(model, { clock });
    if (!resource.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(`resources: integrity check failed for resource "${resourceId}"`);
    }
    return resource;
  }

  async function _activeAllocations(namespace, resourceId) {
    const all = await _safe(() => provider.listAllocations(namespace));
    return all.filter((a) => a.resourceId === resourceId && a.status === 'active');
  }

  // ── §1 registerResource ───────────────────────────────────────────────────────────
  function registerResource(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const resource = createResource(
        { ...spec, namespace },
        { clock, idFactory: idOpts.idFactory }
      );
      return _withLock(_fullKey(namespace, resource.resourceId), async () => {
        const existing = await _safe(() => provider.getResource(namespace, resource.resourceId));
        if (existing) {
          throw new ResourceValidationError(
            `resources: resource "${resource.resourceId}" already exists in "${namespace}"`
          );
        }
        await _safe(() => provider.putResource(namespace, resource.toModel()));
        _indexResource(namespace, resource.resourceId);
        _setStats(namespace, resource.resourceId, resource.capacity, resource.allocated);
        _recordLifecycle('registered', namespace, resource.resourceId);
        _emit(RESOURCE_EVENTS.REGISTERED, {
          resourceId: resource.resourceId,
          namespace,
          resourceType: resource.resourceType,
          capacity: resource.capacity,
        });
        return resource.toPublic();
      });
    })();
  }

  // ── §1 allocate (quota + reservation + priority preemption + conflict detection) ────
  function allocate(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const resourceId = spec.resourceId;
      const amount = spec.amount;
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ResourceValidationError('resources: allocate requires a positive "amount"');
      }
      const owner = spec.owner != null ? spec.owner : 'default';
      const priority = typeof spec.priority === 'number' ? spec.priority : 0;
      return _withLock(_fullKey(namespace, resourceId), async () => {
        const start = clock();
        const resource = await _resolveResource(namespace, resourceId);

        // Quota enforcement (per owner).
        if (resource.quota != null) {
          const active = await _activeAllocations(namespace, resourceId);
          const ownerUsed = active
            .filter((a) => a.owner === owner)
            .reduce((sum, a) => sum + a.amount, 0);
          if (ownerUsed + amount > resource.quota) {
            if (metrics) metrics.recordQuotaViolation();
            _emit(RESOURCE_EVENTS.QUOTA_EXCEEDED, {
              resourceId,
              namespace,
              owner,
              requested: amount,
              quota: resource.quota,
              used: ownerUsed,
            });
            throw new QuotaExceededError(
              `resources: quota exceeded for owner "${owner}" on "${resourceId}"`
            );
          }
        }

        // Capacity — with deterministic priority-based preemption of lower-priority
        // allocations when the request outranks them (conflict resolution).
        if (!resource.canAllocate(amount)) {
          const active = await _activeAllocations(namespace, resourceId);
          const victims = active
            .filter((a) => a.priority < priority)
            .sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? -1 : 1));
          for (const victim of victims) {
            if (resource.canAllocate(amount)) break;
            const va = allocationFromModel(victim, { clock });
            va.release(clock(), true);
            await _safe(() => provider.putAllocation(namespace, va.toModel()));
            _allocStatus.set(_fullKey(namespace, va.allocationId), va.status);
            resource.applyRelease(va.amount, clock());
            if (metrics) {
              metrics.recordPreemption();
              metrics.recordRelease();
            }
            _emit(RESOURCE_EVENTS.RELEASED, {
              resourceId,
              namespace,
              allocationId: va.allocationId,
              preempted: true,
            });
          }
          if (!resource.canAllocate(amount)) {
            if (metrics) metrics.recordConflict();
            throw new ResourceConflictError(
              `resources: insufficient capacity on "${resourceId}" (need ${amount}, available ${resource.allocatable() - resource.allocated})`
            );
          }
        }

        const allocation = createAllocation(
          { resourceId, namespace, owner, amount, priority, metadata: spec.metadata },
          { clock, idFactory: idOpts.idFactory }
        );
        resource.applyAllocate(amount, clock());
        await _safe(() => provider.putAllocation(namespace, allocation.toModel()));
        await _safe(() => provider.putResource(namespace, resource.toModel()));
        _allocStatus.set(_fullKey(namespace, allocation.allocationId), allocation.status);
        _setStats(namespace, resourceId, resource.capacity, resource.allocated);
        if (metrics) {
          metrics.recordAllocation();
          metrics.recordLatency(clock() - start);
        }
        _recordLifecycle('allocated', namespace, allocation.allocationId);
        _emit(RESOURCE_EVENTS.ALLOCATED, {
          resourceId,
          namespace,
          allocationId: allocation.allocationId,
          owner,
          amount,
          available: resource.availableAmount(),
        });
        return allocation.toPublic();
      });
    })();
  }

  // ── §1 release ────────────────────────────────────────────────────────────────────
  function release(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const allocationId = typeof spec === 'string' ? spec : spec.allocationId;
    return (async () => {
      const model = await _safe(() => provider.getAllocation(namespace, allocationId));
      if (!model || model.status !== 'active') return false;
      return _withLock(_fullKey(namespace, model.resourceId), async () => {
        const fresh = await _safe(() => provider.getAllocation(namespace, allocationId));
        if (!fresh || fresh.status !== 'active') return false;
        const allocation = allocationFromModel(fresh, { clock });
        allocation.release(clock(), false);
        await _safe(() => provider.putAllocation(namespace, allocation.toModel()));
        _allocStatus.set(_fullKey(namespace, allocationId), allocation.status);
        const resource = await _resolveResource(namespace, allocation.resourceId);
        resource.applyRelease(allocation.amount, clock());
        await _safe(() => provider.putResource(namespace, resource.toModel()));
        _setStats(namespace, resource.resourceId, resource.capacity, resource.allocated);
        if (metrics) metrics.recordRelease();
        _recordLifecycle('released', namespace, allocationId);
        _emit(RESOURCE_EVENTS.RELEASED, {
          resourceId: allocation.resourceId,
          namespace,
          allocationId,
          preempted: false,
          available: resource.availableAmount(),
        });
        return true;
      });
    })();
  }

  // ── §1 query (resource accounting) ──────────────────────────────────────────────────
  function query(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const resourceId = typeof spec === 'string' ? spec : spec.resourceId;
    return (async () => {
      const resource = await _resolveResource(namespace, resourceId);
      const active = await _activeAllocations(namespace, resourceId);
      return {
        resourceId,
        namespace,
        resourceType: resource.resourceType,
        capacity: resource.capacity,
        allocated: resource.allocated,
        available: resource.availableAmount(),
        allocatable: resource.allocatable(),
        reservation: resource.reservation,
        quota: resource.quota,
        utilization: resource.utilization(),
        status: resource.status,
        activeAllocations: active.length,
      };
    })();
  }

  // ── §1/§9 verify (resource + allocation integrity + accounting consistency) ─────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _resourceIndex.get(namespace) || new Set();
      const allAllocations = await _safe(() => provider.listAllocations(namespace));
      for (const id of ids) {
        const model = await _safe(() => provider.getResource(namespace, id));
        if (!model) {
          issues.push({ resourceId: id, reason: 'missing in provider' });
          continue;
        }
        if (!resourceFromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ resourceId: id, reason: 'checksum mismatch' });
          continue;
        }
        const activeSum = allAllocations
          .filter((a) => a.resourceId === id && a.status === 'active')
          .reduce((sum, a) => sum + a.amount, 0);
        if (activeSum !== model.allocated) {
          issues.push({
            resourceId: id,
            reason: 'accounting drift',
            allocated: model.allocated,
            activeSum,
          });
        }
      }
      if (metrics) metrics.recordVerification();
      const result = { ok: issues.length === 0, issues };
      _emit(RESOURCE_EVENTS.VERIFIED, { namespace, ok: result.ok, issueCount: issues.length });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      resources: _countResources(),
      activeAllocations: _countActiveAllocations(),
      utilization: _utilization(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listResources(namespace));
      return models.map((m) => resourceFromModel(m, { clock }).toPublic());
    })();
  }
  function diagnostics(namespace = 'default') {
    return {
      resources: (_resourceIndex.get(namespace) || new Set()).size,
      totalResources: _countResources(),
      activeAllocations: _countActiveAllocations(),
      utilization: _utilization(),
      namespaces: _resourceIndex.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerResource,
    allocate,
    release,
    query,
    verify,
    health,
    // additive helpers
    list,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createResourceService };
