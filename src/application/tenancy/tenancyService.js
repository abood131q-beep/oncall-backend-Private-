'use strict';

/**
 * Multi-Tenancy Service (Phase 15.9 / ADR-038) — the Multi-Tenancy Kernel. Platform-
 * wide, deterministic tenant isolation, tenant context propagation, tenant-scoped
 * policies, and tenant lifecycle orchestration. This is NOT Kubernetes namespaces /
 * IAM / database schemas — those are provider/infrastructure details.
 *
 * Providers persist tenant definitions; ALL behavior lives here + in the pure
 * domain: deterministic tenant resolution, tenant context propagation, namespace
 * isolation, capability evaluation, lifecycle management, configuration + policy
 * inheritance, tenant verification, and context caching. Events flow ONLY through
 * the EventPublisher port. Deterministic: injected clock. Tenant mutations are
 * atomic via a serialization mutex.
 */

const { createTenant, fromModel } = require('../../domain/tenancy/tenant');
const { buildContext } = require('../../domain/tenancy/context');
const { TENANT_EVENTS, createTenantEvent } = require('../../domain/tenancy/events');
const {
  TenancyValidationError,
  TenantNotFoundError,
  IntegrityError,
} = require('../../domain/tenancy/errors');
const { assertProvider } = require('./providerPort');
const { createContextCache } = require('./cache');
const { createNullPublisher } = require('../shared/eventPublisher');

function createTenancyService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const defaults = deps.defaults || {}; // platform-level inheritance base
  const cache = deps.cache || createContextCache({ maxSize: deps.cacheMaxSize });

  const _index = new Map(); // namespace -> Map(tenantId -> status)
  function _indexSet(ns, id, status) {
    if (!_index.has(ns)) _index.set(ns, new Map());
    _index.get(ns).set(id, status);
  }
  function _countAll() {
    let n = 0;
    for (const m of _index.values()) n += m.size;
    return n;
  }
  function _countStatus(status) {
    let n = 0;
    for (const m of _index.values()) for (const s of m.values()) if (s === status) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({ registered: () => _countAll(), active: () => _countStatus('active') });
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
      const event = createTenantEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('tenancy: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('tenancy: could not build event', e.message);
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

  // ── §1 registerTenant ────────────────────────────────────────────────────────────
  function registerTenant(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const tenant = createTenant({ ...spec, namespace }, { clock, idFactory: idOpts.idFactory });
      return _withLock(_fullKey(namespace, tenant.tenantId), async () => {
        const existing = await _safe(() => provider.getTenant(namespace, tenant.tenantId));
        if (existing) {
          throw new TenancyValidationError(
            `tenancy: tenant "${tenant.tenantId}" already exists in "${namespace}"`
          );
        }
        const byName = await _safe(() => provider.getTenantByName(namespace, tenant.tenantName));
        if (byName) {
          throw new TenancyValidationError(
            `tenancy: tenant name "${tenant.tenantName}" already exists in "${namespace}"`
          );
        }
        await _safe(() => provider.putTenant(namespace, tenant.toModel()));
        _indexSet(namespace, tenant.tenantId, tenant.tenantStatus);
        _recordLifecycle('registered', namespace, tenant.tenantId);
        _emit(TENANT_EVENTS.REGISTERED, {
          tenantId: tenant.tenantId,
          namespace,
          tenantName: tenant.tenantName,
          isolationLevel: tenant.isolationLevel,
        });
        return tenant.toPublic();
      });
    })();
  }

  // ── §1 resolveTenant (deterministic context; cached by checksum) ───────────────────
  function resolveTenant(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const start = clock();
      let model = null;
      if (spec.tenantId) model = await _safe(() => provider.getTenant(namespace, spec.tenantId));
      else if (spec.tenantName) {
        model = await _safe(() => provider.getTenantByName(namespace, spec.tenantName));
      } else {
        throw new TenancyValidationError('tenancy: resolveTenant requires tenantId or tenantName');
      }
      if (!model) {
        throw new TenantNotFoundError(
          `tenancy: tenant ${spec.tenantId || spec.tenantName} not found in "${namespace}"`
        );
      }
      const cacheKey = `${namespace}:${model.tenantId}:${model.checksum}`;
      let context = cache.get(cacheKey);
      if (context !== undefined) {
        if (metrics) metrics.recordCacheHit();
      } else {
        if (metrics) metrics.recordCacheMiss();
        const tenant = fromModel(model, { clock });
        if (!tenant.verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          throw new IntegrityError(
            `tenancy: integrity check failed for tenant "${model.tenantId}"`
          );
        }
        context = buildContext(tenant, { defaults, now: clock() });
        cache.set(cacheKey, context);
      }
      if (metrics) {
        metrics.recordResolution();
        metrics.recordLatency(clock() - start);
      }
      _emit(TENANT_EVENTS.RESOLVED, {
        tenantId: model.tenantId,
        namespace,
        tenantName: model.tenantName,
        status: model.tenantStatus,
      });
      return context;
    })();
  }

  function _mutate(namespace, tenantId, apply, lifecycle, eventType) {
    return _withLock(_fullKey(namespace, tenantId), async () => {
      const model = await _safe(() => provider.getTenant(namespace, tenantId));
      if (!model) {
        throw new TenantNotFoundError(`tenancy: tenant "${tenantId}" not found in "${namespace}"`);
      }
      const tenant = fromModel(model, { clock });
      apply(tenant);
      await _safe(() => provider.putTenant(namespace, tenant.toModel()));
      _indexSet(namespace, tenantId, tenant.tenantStatus);
      cache.invalidate(namespace, tenantId);
      _recordLifecycle(lifecycle, namespace, tenantId);
      _emit(eventType, {
        tenantId,
        namespace,
        tenantName: tenant.tenantName,
        status: tenant.tenantStatus,
      });
      return tenant.toPublic();
    });
  }

  // ── §1 activateTenant / deactivateTenant ──────────────────────────────────────────
  function activateTenant(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.tenantId;
    return _mutate(
      namespace,
      id,
      (t) => t.activate(clock()),
      'activated',
      TENANT_EVENTS.ACTIVATED
    ).then((r) => {
      if (metrics) metrics.recordActivation();
      return r;
    });
  }
  function deactivateTenant(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.tenantId;
    return _mutate(
      namespace,
      id,
      (t) => t.deactivate(clock()),
      'deactivated',
      TENANT_EVENTS.DEACTIVATED
    ).then((r) => {
      if (metrics) metrics.recordDeactivation();
      return r;
    });
  }

  // ── §1/§9 verify (tenant integrity across a namespace) ─────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _index.get(namespace) || new Map();
      for (const id of ids.keys()) {
        const model = await _safe(() => provider.getTenant(namespace, id));
        if (!model) {
          issues.push({ tenantId: id, reason: 'missing in provider' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ tenantId: id, reason: 'checksum mismatch' });
        }
      }
      if (metrics) metrics.recordVerification();
      const result = { ok: issues.length === 0, issues };
      _emit(TENANT_EVENTS.VERIFIED, { namespace, ok: result.ok, issueCount: issues.length });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      tenants: _countAll(),
      active: _countStatus('active'),
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listTenants(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  function update(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = spec.tenantId;
    const patch = spec.patch || spec;
    return _mutate(
      namespace,
      id,
      (t) => t.applyUpdate(patch, clock()),
      'updated',
      TENANT_EVENTS.UPDATED
    );
  }
  function diagnostics(namespace = 'default') {
    return {
      tenants: (_index.get(namespace) || new Map()).size,
      totalTenants: _countAll(),
      active: _countStatus('active'),
      namespaces: _index.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerTenant,
    resolveTenant,
    activateTenant,
    deactivateTenant,
    verify,
    health,
    // additive helpers
    update,
    list,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createTenancyService };
