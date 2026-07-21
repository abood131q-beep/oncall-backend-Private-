'use strict';

/**
 * API Gateway Service (Phase 15.6 / ADR-035) — the API Gateway Kernel. Platform-wide,
 * deterministic request routing, endpoint resolution, middleware orchestration, and
 * gateway policy enforcement. This is NOT Kong/Envoy/NGINX and NOT an HTTP server —
 * it resolves + orchestrates a request and returns the dispatch decision.
 *
 * Providers persist route definitions; ALL behavior lives here + in the pure
 * matching domain: deterministic route resolution, version-aware routing, a
 * middleware pipeline, policy enforcement, identity context propagation, rate-limit +
 * feature-flag + service-discovery integration (through injected kernel ports only),
 * request validation, timeout handling, and diagnostics. Events flow ONLY through the
 * EventPublisher port. Deterministic: injected clock. Per-route mutations are atomic
 * via a serialization mutex.
 */

const { createRoute, fromModel } = require('../../domain/gateway/route');
const { resolveRoutes } = require('../../domain/gateway/matching');
const { GATEWAY_EVENTS, createGatewayEvent } = require('../../domain/gateway/events');
const {
  GatewayValidationError,
  RouteNotFoundError,
  GatewayRejectedError,
} = require('../../domain/gateway/errors');
const { assertProvider } = require('./providerPort');
const { createRouteCache } = require('./cache');
const { createNullPublisher } = require('../shared/eventPublisher');

function createGatewayService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };
  const cache = deps.cache || createRouteCache({ maxNamespaces: deps.cacheMaxNamespaces });
  // Injected kernel ports (all optional) — integration ONLY through public ports.
  const ports = deps.ports || {};

  const _middleware = new Map(); // name -> async (ctx) => ctx | throws GatewayRejectedError
  const _handlers = new Map(); // routeId -> async (ctx) => result
  const _index = new Map(); // namespace -> Set(routeId)
  function _indexAdd(ns, id) {
    if (!_index.has(ns)) _index.set(ns, new Set());
    _index.get(ns).add(id);
  }
  function _indexRemove(ns, id) {
    const s = _index.get(ns);
    if (s) s.delete(id);
  }
  function _countRoutes() {
    let n = 0;
    for (const s of _index.values()) n += s.size;
    return n;
  }
  if (metrics && metrics.bindGauges) metrics.bindGauges({ routes: () => _countRoutes() });

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
      const event = createGatewayEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('gateway: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('gateway: could not build event', e.message);
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

  async function _loadRoutes(namespace) {
    const cached = cache.get(namespace);
    if (cached !== undefined) {
      if (metrics) metrics.recordCacheHit();
      return cached;
    }
    if (metrics) metrics.recordCacheMiss();
    const routes = await _safe(() => provider.listRoutes(namespace));
    cache.set(namespace, routes);
    return routes;
  }

  function _reject(namespace, reason, detail) {
    if (metrics) metrics.recordPolicyRejection();
    _emit(GATEWAY_EVENTS.GATEWAY_REJECTED, { namespace, reason, detail: detail || null });
    throw new GatewayRejectedError(`gateway: rejected (${reason})`, reason, detail);
  }

  /** Register a named middleware (engine-level; not persisted, not exposed to SDK). */
  function registerMiddleware(name, fn) {
    if (!name || typeof name !== 'string') {
      throw new GatewayValidationError('gateway: middleware name required');
    }
    if (typeof fn !== 'function')
      throw new GatewayValidationError('gateway: middleware fn required');
    _middleware.set(name, fn);
    return { name, registered: true };
  }

  // ── §1 registerRoute (upsert) ─────────────────────────────────────────────────
  function registerRoute(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const route = createRoute({ ...spec, namespace }, { clock, idFactory: idOpts.idFactory });
      const id = route.routeId;
      return _withLock(`${namespace}::${id}`, async () => {
        const existing = await _safe(() => provider.getRoute(namespace, id));
        await _safe(() => provider.putRoute(namespace, route.toModel()));
        if (typeof spec.handler === 'function') _handlers.set(id, spec.handler);
        cache.invalidate(namespace);
        _indexAdd(namespace, id);
        _recordLifecycle(existing ? 'updated' : 'registered', namespace, id);
        _emit(existing ? GATEWAY_EVENTS.ROUTE_UPDATED : GATEWAY_EVENTS.ROUTE_REGISTERED, {
          routeId: id,
          namespace,
          method: route.method,
          path: route.path,
          version: route.version,
        });
        return route.toPublic();
      });
    })();
  }

  async function _match(namespace, request) {
    const routes = await _loadRoutes(namespace);
    return resolveRoutes(routes, request);
  }

  // ── §1 resolve (match only) ─────────────────────────────────────────────────────
  function resolve(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const start = clock();
      const request = { method: spec.method, path: spec.path, version: spec.version };
      const matches = await _match(namespace, request);
      if (metrics) metrics.recordLatency(clock() - start);
      if (!matches.length) {
        if (metrics) metrics.recordResolvedFail();
        _emit(GATEWAY_EVENTS.GATEWAY_REJECTED, { namespace, reason: 'no_route', detail: request });
        throw new RouteNotFoundError(
          `gateway: no route for ${request.method} ${request.path} in "${namespace}"`
        );
      }
      if (metrics) metrics.recordResolvedOk();
      const top = matches[0];
      _emit(GATEWAY_EVENTS.ROUTE_RESOLVED, {
        namespace,
        routeId: top.route.routeId,
        method: top.route.method,
        path: top.route.path,
      });
      return {
        namespace,
        route: { ...top.route },
        params: top.params,
        candidateCount: matches.length,
      };
    })();
  }

  // ── §1 dispatch (resolve → enforce → orchestrate) ─────────────────────────────────
  function dispatch(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const start = clock();
      if (metrics) metrics.recordDispatch();
      const request = {
        method: spec.method,
        path: spec.path,
        version: spec.version,
        headers: spec.headers || {},
        body: spec.body,
      };
      const matches = await _match(namespace, request);
      if (!matches.length) {
        if (metrics) metrics.recordResolvedFail();
        _emit(GATEWAY_EVENTS.GATEWAY_REJECTED, { namespace, reason: 'no_route', detail: request });
        throw new RouteNotFoundError(
          `gateway: no route for ${request.method} ${request.path} in "${namespace}"`
        );
      }
      if (metrics) metrics.recordResolvedOk();
      const { route: routeModel, params } = matches[0];
      const route = fromModel(routeModel, { clock });
      // Route integrity before we trust it.
      if (!route.verifyChecksum()) {
        if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
        _reject(namespace, 'integrity', { routeId: route.routeId });
      }

      const ctx = {
        request: { ...request, params },
        route: route.toPublic(),
        identity: null,
        correlationId: spec.correlationId || null,
        middlewareTrace: [],
      };

      // Authentication + identity context propagation (Identity kernel port).
      if (route.authRequired) {
        if (!ports.identity || typeof ports.identity.resolve !== 'function') {
          _reject(namespace, 'unauthenticated', { routeId: route.routeId });
        }
        const idres = await ports.identity.resolve({
          sessionId: spec.sessionId,
          token: spec.token,
          principal: spec.principal,
        });
        if (
          !idres ||
          idres.ok === false ||
          (idres.context && idres.context.authenticated === false)
        ) {
          _reject(namespace, 'unauthenticated', { routeId: route.routeId });
        }
        ctx.identity = idres.context || idres;
      }

      // Feature-flag gating (Feature Flag kernel port).
      const flagName = route.metadata && route.metadata.featureFlag;
      if (flagName && ports.features && typeof ports.features.evaluate === 'function') {
        const f = await ports.features.evaluate({ name: flagName, context: ctx.identity || {} });
        if (!f || f.served === false || f.value === false) {
          _reject(namespace, 'feature_disabled', { flag: flagName });
        }
      }

      // Policy enforcement (Policy kernel port).
      if (ports.policy && typeof ports.policy.evaluate === 'function') {
        for (const policyId of route.policies) {
          const decision = await ports.policy.evaluate({
            policyId,
            context: ctx.identity || {},
            action: route.method,
            resource: route.path,
          });
          const denied =
            decision &&
            (decision.effect === 'deny' ||
              decision.effect === 'DENY' ||
              decision.allowed === false);
          if (denied) _reject(namespace, 'policy_denied', { policyId });
        }
      }

      // Rate limiting (Rate Limiting kernel port).
      if (
        route.rateLimitPolicy &&
        ports.ratelimit &&
        typeof ports.ratelimit.consume === 'function'
      ) {
        const subject = spec.subject || (ctx.identity && ctx.identity.principal) || 'anonymous';
        const r = await ports.ratelimit.consume({ policyId: route.rateLimitPolicy, subject });
        if (r && r.allowed === false) _reject(namespace, 'rate_limited', { subject });
      }

      // Target resolution (Service Discovery kernel port) — else the static endpoint.
      let target = { service: route.targetService, endpoint: route.targetEndpoint };
      if (route.targetService && ports.discovery && typeof ports.discovery.resolve === 'function') {
        try {
          const res = await ports.discovery.resolve({
            serviceName: route.targetService,
            key: spec.subject,
          });
          target = { service: route.targetService, endpoint: res.selected.endpoint };
        } catch (e) {
          _reject(namespace, 'service_unavailable', {
            service: route.targetService,
            error: e.message,
          });
        }
      }

      // Middleware pipeline (deterministic, in declared order).
      for (const name of route.middlewareChain) {
        const fn = _middleware.get(name);
        if (!fn) _reject(namespace, 'middleware_missing', { middleware: name });
        try {
          await fn(ctx);
        } catch (e) {
          if (e instanceof GatewayRejectedError) throw e;
          _reject(namespace, 'middleware_error', { middleware: name, error: e.message });
        }
        ctx.middlewareTrace.push(name);
      }

      // Upstream handler (optional; a gateway resolves + orchestrates, it is not an
      // HTTP server — a handler is only run when one is registered for the route).
      let result = null;
      const handler = _handlers.get(route.routeId);
      if (handler) result = await handler(ctx);

      // Timeout handling (deterministic; injected clock).
      const elapsed = clock() - start;
      if (route.timeout != null && elapsed > route.timeout) {
        _reject(namespace, 'timeout', { routeId: route.routeId, elapsed });
      }
      if (metrics) metrics.recordLatency(elapsed);
      _emit(GATEWAY_EVENTS.REQUEST_DISPATCHED, {
        namespace,
        routeId: route.routeId,
        method: route.method,
        path: route.path,
        target: target.service || target.endpoint,
        correlationId: ctx.correlationId,
      });
      return {
        status: 'dispatched',
        namespace,
        routeId: route.routeId,
        target,
        params,
        identity: ctx.identity ? ctx.identity.principal || null : null,
        middlewareTrace: ctx.middlewareTrace,
        result,
        latencyMs: elapsed,
      };
    })();
  }

  // ── §1 listRoutes ────────────────────────────────────────────────────────────────
  function listRoutes(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const routes = await _safe(() => provider.listRoutes(namespace));
      return routes.map((r) => ({ ...r }));
    })();
  }

  // ── §1/§9 verify (route + middleware integrity) ─────────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const routes = await _safe(() => provider.listRoutes(namespace));
      for (const model of routes) {
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ routeId: model.routeId, reason: 'checksum mismatch' });
          continue;
        }
        for (const name of model.middlewareChain || []) {
          if (!_middleware.has(name)) {
            issues.push({ routeId: model.routeId, reason: `middleware "${name}" not registered` });
          }
        }
      }
      const result = { ok: issues.length === 0, issues };
      _emit(GATEWAY_EVENTS.GATEWAY_VERIFIED, {
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
      routes: _countRoutes(),
      middleware: _middleware.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function deregister(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.routeId;
    return _withLock(`${namespace}::${id}`, async () => {
      const removed = await _safe(() => provider.removeRoute(namespace, id));
      _indexRemove(namespace, id);
      _handlers.delete(id);
      cache.invalidate(namespace);
      if (removed) _recordLifecycle('deregistered', namespace, id);
      return Boolean(removed);
    });
  }
  async function snapshotRoute(namespace, routeId) {
    const m = await _safe(() => provider.getRoute(namespace, routeId));
    return m ? _deepFreeze(fromModel(m, { clock }).toPublic()) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      routes: (_index.get(namespace) || new Set()).size,
      totalRoutes: _countRoutes(),
      middleware: [..._middleware.keys()],
      namespaces: _index.size,
      cache: cache.stats(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerRoute,
    resolve,
    dispatch,
    listRoutes,
    verify,
    health,
    // additive helpers
    registerMiddleware,
    deregister,
    snapshotRoute,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createGatewayService };
