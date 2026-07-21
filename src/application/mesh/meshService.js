'use strict';

/**
 * Service Mesh Service (Phase 15.8 / ADR-037) — the Service Mesh Kernel. Platform-
 * wide, deterministic service-to-service communication policies, traffic
 * orchestration, secure invocation abstractions, and mesh governance. This is NOT
 * Istio/Linkerd/Consul Connect and NOT a network proxy — those are provider
 * extension points.
 *
 * Providers persist connection definitions; ALL behavior lives here + in the pure
 * domain: deterministic service invocation, connection lifecycle management, policy
 * evaluation, traffic-routing abstraction, connection validation, identity + secure
 * context propagation, retry delegation, timeout enforcement, and invocation
 * history. Cross-kernel integration is through INJECTED ports only. Events flow ONLY
 * through the EventPublisher port. Deterministic: injected clock. Connection
 * mutations are atomic via a serialization mutex.
 */

const { createConnection, fromModel, STATE } = require('../../domain/mesh/connection');
const { evaluatePolicies } = require('../../domain/mesh/policies');
const { MESH_EVENTS, createMeshEvent } = require('../../domain/mesh/events');
const {
  MeshValidationError,
  ConnectionNotFoundError,
  MeshRejectedError,
  IntegrityError,
} = require('../../domain/mesh/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createMeshService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idFactory =
    deps.idFactory ||
    ((p) => `${p}_${clock().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const ports = deps.ports || {};

  const _index = new Map(); // namespace -> Map(connectionId -> connectionState)
  const _inflight = new Map(); // `${ns}::${connectionId}` -> in-flight invocations

  function _indexSet(ns, id, state) {
    if (!_index.has(ns)) _index.set(ns, new Map());
    _index.get(ns).set(id, state);
  }
  function _indexRemove(ns, id) {
    const m = _index.get(ns);
    if (m) m.delete(id);
  }
  function _countAll() {
    let n = 0;
    for (const m of _index.values()) n += m.size;
    return n;
  }
  function _countState(status) {
    let n = 0;
    for (const m of _index.values()) for (const s of m.values()) if (s === status) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      registered: () => _countAll(),
      active: () => _countState(STATE.ESTABLISHED),
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
      const event = createMeshEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('mesh: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('mesh: could not build event', e.message);
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

  async function _resolveConnection(namespace, connectionId) {
    const model = await _safe(() => provider.getConnection(namespace, connectionId));
    if (!model) {
      throw new ConnectionNotFoundError(
        `mesh: connection "${connectionId}" not found in "${namespace}"`
      );
    }
    const connection = fromModel(model, { clock });
    if (!connection.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(`mesh: integrity check failed for connection "${connectionId}"`);
    }
    return connection;
  }

  function _reject(namespace, connectionId, reason, detail) {
    if (metrics) metrics.recordPolicyViolation();
    _emit(MESH_EVENTS.INVOCATION_FAILED, {
      namespace,
      connectionId,
      reason,
      detail: detail || null,
    });
    throw new MeshRejectedError(`mesh: invocation rejected (${reason})`, reason, detail);
  }

  // ── §1 registerPolicy (register a connection definition) ──────────────────────────
  function registerPolicy(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const connection = createConnection({ ...spec, namespace }, { clock, idFactory });
      const id = connection.connectionId;
      return _withLock(_fullKey(namespace, id), async () => {
        const existing = await _safe(() => provider.getConnection(namespace, id));
        if (existing) {
          throw new MeshValidationError(
            `mesh: connection "${id}" already exists in "${namespace}"`
          );
        }
        await _safe(() => provider.putConnection(namespace, connection.toModel()));
        _indexSet(namespace, id, connection.connectionState);
        _recordLifecycle('registered', namespace, id);
        _emit(MESH_EVENTS.CONNECTION_REGISTERED, {
          connectionId: id,
          namespace,
          sourceService: connection.sourceService,
          destinationService: connection.destinationService,
        });
        return connection.toPublic();
      });
    })();
  }

  // ── §1 connect (establish the connection) ─────────────────────────────────────────
  function connect(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.connectionId;
    return _withLock(_fullKey(namespace, id), async () => {
      const connection = await _resolveConnection(namespace, id);
      connection.establish(clock());
      await _safe(() => provider.putConnection(namespace, connection.toModel()));
      _indexSet(namespace, id, connection.connectionState);
      if (metrics) metrics.recordEstablished();
      _recordLifecycle('established', namespace, id);
      _emit(MESH_EVENTS.CONNECTION_ESTABLISHED, {
        connectionId: id,
        namespace,
        sourceService: connection.sourceService,
        destinationService: connection.destinationService,
      });
      return connection.toPublic();
    });
  }

  async function _runWithTimeout(fn, ctx, timeout) {
    const start = clock();
    const result = await fn(ctx);
    if (timeout != null && clock() - start > timeout) {
      const e = new Error(`mesh: invocation exceeded timeout ${timeout}ms`);
      e.name = 'ExecutionTimeoutError';
      throw e;
    }
    return result;
  }

  // ── §1 invoke (the secured, policy-governed invocation) ────────────────────────────
  function invoke(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      if (typeof spec.fn !== 'function') {
        throw new MeshValidationError('mesh: invoke requires a "fn" function');
      }
      const connection = await _resolveConnection(namespace, spec.connectionId);
      const id = connection.connectionId;
      if (!connection.isEstablished()) {
        _reject(namespace, id, 'not_connected');
      }

      // Identity propagation (Identity kernel port).
      let identity = spec.identity || null;
      if (
        !identity &&
        ports.identity &&
        typeof ports.identity.resolve === 'function' &&
        (spec.token || spec.sessionId || spec.principal)
      ) {
        const idres = await ports.identity.resolve({
          sessionId: spec.sessionId,
          token: spec.token,
          principal: spec.principal,
        });
        identity =
          idres && idres.context ? idres.context : idres && idres.ok !== false ? idres : null;
      }

      const context = {
        sourceService: spec.sourceService != null ? spec.sourceService : connection.sourceService,
        identity,
        secure: spec.secure,
        traceContext: spec.traceContext || null,
      };

      // Security + mutual identity admission (pure domain).
      const decision = evaluatePolicies(connection, context);
      if (!decision.allowed) _reject(namespace, id, decision.reason);

      // Policy enforcement (Policy kernel port).
      if (ports.policy && typeof ports.policy.evaluate === 'function') {
        const d = await ports.policy.evaluate({
          context: identity || {},
          action: 'invoke',
          resource: connection.destinationService,
        });
        if (d && (d.effect === 'deny' || d.allowed === false))
          _reject(namespace, id, 'policy_denied');
      }

      // Rate limiting (Rate Limiting kernel port).
      const rlPolicy = connection.trafficPolicy && connection.trafficPolicy.rateLimitPolicy;
      if (rlPolicy && ports.ratelimit && typeof ports.ratelimit.consume === 'function') {
        const subject = spec.subject || context.sourceService;
        const r = await ports.ratelimit.consume({ policyId: rlPolicy, subject });
        if (r && r.allowed === false) _reject(namespace, id, 'rate_limited');
      }

      // Traffic concurrency limit (engine-held counter).
      const maxConcurrent = connection.trafficPolicy && connection.trafficPolicy.maxConcurrent;
      const flightKey = _fullKey(namespace, id);
      const inflight = _inflight.get(flightKey) || 0;
      if (maxConcurrent && inflight >= maxConcurrent) {
        _reject(namespace, id, 'traffic_limit', { maxConcurrent });
      }
      _inflight.set(flightKey, inflight + 1);

      // Destination endpoint (Service Discovery kernel port) — else the service name.
      let endpoint = null;
      if (ports.discovery && typeof ports.discovery.resolve === 'function') {
        try {
          const res = await ports.discovery.resolve({
            serviceName: connection.destinationService,
            key: spec.subject,
          });
          endpoint = res && res.selected ? res.selected.endpoint : null;
        } catch (e) {
          _inflight.set(flightKey, (_inflight.get(flightKey) || 1) - 1);
          _reject(namespace, id, 'destination_unavailable', { error: e.message });
        }
      }

      const invocationId = idFactory('inv');
      const secureContext = {
        invocationId,
        connectionId: id,
        source: context.sourceService,
        destination: connection.destinationService,
        endpoint,
        route: decision.route,
        identity: context.identity || null,
        traceContext: context.traceContext,
      };

      if (metrics) metrics.recordInvocation();
      _emit(MESH_EVENTS.INVOCATION_STARTED, {
        invocationId,
        namespace,
        connectionId: id,
        destination: connection.destinationService,
      });

      const start = clock();
      try {
        let result;
        const rp = connection.retryPolicy;
        if (
          rp &&
          rp.resiliencePolicyId &&
          ports.resilience &&
          typeof ports.resilience.execute === 'function'
        ) {
          // Retry delegation to the Resilience kernel.
          const r = await ports.resilience.execute({
            policyId: rp.resiliencePolicyId,
            subject: id,
            fn: () => _runWithTimeout(spec.fn, secureContext, connection.timeout),
          });
          result = r.result;
        } else {
          result = await _runWithTimeout(spec.fn, secureContext, connection.timeout);
        }
        if (metrics) {
          metrics.recordSuccess();
          metrics.recordLatency(clock() - start);
        }
        _emit(MESH_EVENTS.INVOCATION_COMPLETED, {
          invocationId,
          namespace,
          connectionId: id,
          destination: connection.destinationService,
        });
        return {
          ok: true,
          invocationId,
          connectionId: id,
          result,
          route: decision.route,
          latencyMs: clock() - start,
        };
      } catch (err) {
        if (metrics) metrics.recordFailure();
        _emit(MESH_EVENTS.INVOCATION_FAILED, {
          invocationId,
          namespace,
          connectionId: id,
          reason: err && err.message,
        });
        throw err;
      } finally {
        _inflight.set(flightKey, (_inflight.get(flightKey) || 1) - 1);
      }
    })();
  }

  // ── §1 disconnect ─────────────────────────────────────────────────────────────────
  function disconnect(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.connectionId;
    return _withLock(_fullKey(namespace, id), async () => {
      const model = await _safe(() => provider.getConnection(namespace, id));
      if (!model) return false;
      const connection = fromModel(model, { clock });
      connection.close(clock());
      await _safe(() => provider.putConnection(namespace, connection.toModel()));
      _indexSet(namespace, id, connection.connectionState);
      if (metrics) metrics.recordClosed();
      _recordLifecycle('closed', namespace, id);
      _emit(MESH_EVENTS.CONNECTION_CLOSED, { connectionId: id, namespace });
      return true;
    });
  }

  // ── §1/§9 verify (connection integrity across a namespace) ─────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _index.get(namespace) || new Map();
      for (const id of ids.keys()) {
        const model = await _safe(() => provider.getConnection(namespace, id));
        if (!model) {
          issues.push({ connectionId: id, reason: 'missing in provider' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ connectionId: id, reason: 'checksum mismatch' });
        }
      }
      const result = { ok: issues.length === 0, issues };
      _emit(MESH_EVENTS.MESH_VERIFIED, { namespace, ok: result.ok, issueCount: issues.length });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      connections: _countAll(),
      active: _countState(STATE.ESTABLISHED),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listConnections(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  function diagnostics(namespace = 'default') {
    return {
      connections: (_index.get(namespace) || new Map()).size,
      totalConnections: _countAll(),
      active: _countState(STATE.ESTABLISHED),
      closed: _countState(STATE.CLOSED),
      namespaces: _index.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    registerPolicy,
    connect,
    invoke,
    disconnect,
    verify,
    health,
    // additive helpers
    list,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createMeshService };
