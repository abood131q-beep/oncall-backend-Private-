'use strict';

/**
 * Lifecycle Management Service (Phase 15.11 / ADR-040) — the Lifecycle Management
 * Kernel. Platform-wide, deterministic component registration, initialization,
 * startup sequencing, graceful shutdown, suspension, resumption, and lifecycle
 * governance. This is NOT systemd/K8s Operators/Docker Compose/PM2 — those are
 * process supervisors.
 *
 * Providers persist lifecycle metadata; ALL orchestration lives here + in the pure
 * domain: deterministic startup ordering (topological sort), dependency-graph
 * validation, initialization orchestration, graceful shutdown (reverse order),
 * restart coordination, suspend/resume, state-transition validation, lifecycle
 * history, verification, and health-aware orchestration. Events flow ONLY through the
 * EventPublisher port. Deterministic: injected clock. Orchestration is atomic per
 * namespace via a serialization mutex.
 */

const { createComponent, fromModel, STATE } = require('../../domain/lifecycle/component');
const { topoSort, shutdownOrder } = require('../../domain/lifecycle/graph');
const { LIFECYCLE_EVENTS, createLifecycleEvent } = require('../../domain/lifecycle/events');
const {
  LifecycleValidationError,
  ComponentNotFoundError,
  DependencyError,
  TransitionError,
  IntegrityError,
} = require('../../domain/lifecycle/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createLifecycleService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _hooks = new Map(); // `${ns}::${componentId}` -> { initialize, start, stop }
  const _index = new Map(); // namespace -> Map(componentId -> lifecycleState)
  function _indexSet(ns, id, state) {
    if (!_index.has(ns)) _index.set(ns, new Map());
    _index.get(ns).set(id, state);
  }
  function _countAll() {
    let n = 0;
    for (const m of _index.values()) n += m.size;
    return n;
  }
  function _countState(state) {
    let n = 0;
    for (const m of _index.values()) for (const s of m.values()) if (s === state) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      registered: () => _countAll(),
      running: () => _countState(STATE.STARTED),
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
      const event = createLifecycleEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('lifecycle: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('lifecycle: could not build event', e.message);
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

  const _hookKey = (ns, id) => `${ns}::${id}`;

  async function _load(namespace, componentId) {
    const model = await _safe(() => provider.getComponent(namespace, componentId));
    if (!model) {
      throw new ComponentNotFoundError(
        `lifecycle: component "${componentId}" not found in "${namespace}"`
      );
    }
    const component = fromModel(model, { clock });
    if (!component.verifyChecksum()) {
      if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
      throw new IntegrityError(`lifecycle: integrity check failed for component "${componentId}"`);
    }
    return component;
  }

  function _applyTransition(component, to) {
    try {
      component.transition(to, clock());
    } catch (e) {
      if (e instanceof TransitionError && metrics) metrics.recordFailedTransition();
      throw e;
    }
  }

  async function _persist(namespace, component, lifecycleType, eventType) {
    await _safe(() => provider.putComponent(namespace, component.toModel()));
    _indexSet(namespace, component.componentId, component.lifecycleState);
    if (lifecycleType) _recordLifecycle(lifecycleType, namespace, component.componentId);
    if (eventType) {
      _emit(eventType, {
        componentId: component.componentId,
        namespace,
        state: component.lifecycleState,
      });
    }
    _emit(LIFECYCLE_EVENTS.STATE_CHANGED, {
      componentId: component.componentId,
      namespace,
      state: component.lifecycleState,
    });
  }

  async function _runHook(namespace, component, name) {
    const hooks = _hooks.get(_hookKey(namespace, component.componentId));
    const hook = hooks && hooks[name];
    if (typeof hook === 'function') {
      await hook({
        componentId: component.componentId,
        namespace,
        componentType: component.componentType,
        metadata: component.metadata,
      });
    }
  }

  // ── §1 register ────────────────────────────────────────────────────────────────
  function register(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const component = createComponent(
        { ...spec, namespace },
        { clock, idFactory: idOpts.idFactory }
      );
      return _withLock(_hookKey(namespace, component.componentId), async () => {
        const existing = await _safe(() => provider.getComponent(namespace, component.componentId));
        if (existing) {
          throw new LifecycleValidationError(
            `lifecycle: component "${component.componentId}" already exists in "${namespace}"`
          );
        }
        await _safe(() => provider.putComponent(namespace, component.toModel()));
        if (spec.hooks && typeof spec.hooks === 'object') {
          _hooks.set(_hookKey(namespace, component.componentId), { ...spec.hooks });
        }
        _indexSet(namespace, component.componentId, component.lifecycleState);
        _recordLifecycle('registered', namespace, component.componentId);
        _emit(LIFECYCLE_EVENTS.COMPONENT_REGISTERED, {
          componentId: component.componentId,
          namespace,
          componentType: component.componentType,
          dependencies: component.dependencies,
        });
        return component.toPublic();
      });
    })();
  }

  async function _initOne(namespace, component) {
    if (
      component.lifecycleState === STATE.INITIALIZED ||
      component.lifecycleState === STATE.STARTED
    ) {
      return component;
    }
    await _runHook(namespace, component, 'initialize');
    _applyTransition(component, STATE.INITIALIZED);
    if (metrics) metrics.recordInitialized();
    await _persist(namespace, component, 'initialized', LIFECYCLE_EVENTS.COMPONENT_INITIALIZED);
    return component;
  }

  async function _startOne(namespace, component, startedSet) {
    if (component.lifecycleState === STATE.STARTED) return component;
    // Health-aware: every dependency must already be started.
    for (const dep of component.dependencies) {
      if (!startedSet.has(dep)) {
        const depModel = await _safe(() => provider.getComponent(namespace, dep));
        if (!depModel || depModel.lifecycleState !== STATE.STARTED) {
          throw new DependencyError(
            `lifecycle: cannot start "${component.componentId}" — dependency "${dep}" is not started`
          );
        }
        startedSet.add(dep);
      }
    }
    if (
      component.lifecycleState === STATE.REGISTERED ||
      component.lifecycleState === STATE.STOPPED ||
      component.lifecycleState === STATE.FAILED
    ) {
      await _initOne(namespace, component);
    }
    const start = clock();
    await _runHook(namespace, component, 'start');
    _applyTransition(component, STATE.STARTED);
    if (metrics) {
      metrics.recordStarted();
      metrics.recordStartupLatency(clock() - start);
    }
    await _persist(namespace, component, 'started', LIFECYCLE_EVENTS.COMPONENT_STARTED);
    startedSet.add(component.componentId);
    return component;
  }

  async function _stopOne(namespace, component) {
    if (
      component.lifecycleState === STATE.STOPPED ||
      component.lifecycleState === STATE.REGISTERED
    ) {
      return component;
    }
    const start = clock();
    await _runHook(namespace, component, 'stop');
    _applyTransition(component, STATE.STOPPED);
    if (metrics) {
      metrics.recordStopped();
      metrics.recordShutdownLatency(clock() - start);
    }
    await _persist(namespace, component, 'stopped', LIFECYCLE_EVENTS.COMPONENT_STOPPED);
    return component;
  }

  async function _validatedOrder(namespace) {
    const models = await _safe(() => provider.listComponents(namespace));
    const sorted = topoSort(models);
    if (!sorted.ok) {
      throw new DependencyError(
        sorted.cycle
          ? `lifecycle: dependency cycle detected: ${sorted.cycle.join(', ')}`
          : `lifecycle: missing dependencies: ${sorted.missing.map((m) => m.dependency).join(', ')}`,
        sorted
      );
    }
    return { models, order: sorted.order };
  }

  // ── §1 initialize ──────────────────────────────────────────────────────────────
  function initialize(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      if (componentId)
        return (await _initOne(namespace, await _load(namespace, componentId))).toPublic();
      const { models, order } = await _validatedOrder(namespace);
      const byId = new Map(models.map((m) => [m.componentId, m]));
      const out = [];
      for (const id of order)
        out.push((await _initOne(namespace, fromModel(byId.get(id), { clock }))).toPublic());
      return out;
    });
  }

  // ── §1 start (deterministic dependency-ordered startup) ─────────────────────────
  function start(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      const startedSet = new Set();
      for (const m of await _safe(() => provider.listComponents(namespace))) {
        if (m.lifecycleState === STATE.STARTED) startedSet.add(m.componentId);
      }
      if (componentId) {
        return (
          await _startOne(namespace, await _load(namespace, componentId), startedSet)
        ).toPublic();
      }
      const { models, order } = await _validatedOrder(namespace);
      const byId = new Map(models.map((m) => [m.componentId, m]));
      const out = [];
      for (const id of order)
        out.push(
          (await _startOne(namespace, fromModel(byId.get(id), { clock }), startedSet)).toPublic()
        );
      return out;
    });
  }

  // ── §1 stop (graceful, reverse dependency order) ────────────────────────────────
  function stop(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      if (componentId)
        return (await _stopOne(namespace, await _load(namespace, componentId))).toPublic();
      const models = await _safe(() => provider.listComponents(namespace));
      const rev = shutdownOrder(models);
      const order = rev.ok ? rev.order : models.map((m) => m.componentId);
      const byId = new Map(models.map((m) => [m.componentId, m]));
      const out = [];
      for (const id of order)
        out.push((await _stopOne(namespace, fromModel(byId.get(id), { clock }))).toPublic());
      return out;
    });
  }

  // ── §1 restart ────────────────────────────────────────────────────────────────────
  function restart(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      const stopped = await _stopOne(namespace, await _load(namespace, componentId));
      void stopped;
      const startedSet = new Set();
      for (const m of await _safe(() => provider.listComponents(namespace))) {
        if (m.lifecycleState === STATE.STARTED) startedSet.add(m.componentId);
      }
      const started = await _startOne(namespace, await _load(namespace, componentId), startedSet);
      if (metrics) metrics.recordRestart();
      _recordLifecycle('restarted', namespace, componentId);
      _emit(LIFECYCLE_EVENTS.COMPONENT_RESTARTED, {
        componentId,
        namespace,
        state: started.lifecycleState,
      });
      return started.toPublic();
    });
  }

  // ── §1 status ──────────────────────────────────────────────────────────────────
  function status(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return (async () => {
      const model = await _safe(() => provider.getComponent(namespace, componentId));
      return model || null;
    })();
  }

  // ── §1/§9 verify (dependency graph + checksum integrity) ────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const models = await _safe(() => provider.listComponents(namespace));
      for (const model of models) {
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ componentId: model.componentId, reason: 'checksum mismatch' });
        }
      }
      const sorted = topoSort(models);
      if (!sorted.ok) {
        if (sorted.cycle) issues.push({ reason: 'dependency cycle', cycle: sorted.cycle });
        for (const m of sorted.missing) {
          issues.push({
            componentId: m.componentId,
            reason: 'missing dependency',
            dependency: m.dependency,
          });
        }
      }
      if (metrics) metrics.recordVerification();
      const result = {
        ok: issues.length === 0,
        issues,
        startupOrder: sorted.ok ? sorted.order : null,
      };
      _emit(LIFECYCLE_EVENTS.VERIFIED, { namespace, ok: result.ok, issueCount: issues.length });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      components: _countAll(),
      started: _countState(STATE.STARTED),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers: suspend / resume / list / diagnostics / history ──────────────
  function suspend(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      const component = await _load(namespace, componentId);
      _applyTransition(component, STATE.SUSPENDED);
      await _persist(namespace, component, 'suspended', null);
      return component.toPublic();
    });
  }
  function resume(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = typeof spec === 'string' ? spec : spec.componentId;
    return _withLock(namespace, async () => {
      const component = await _load(namespace, componentId);
      _applyTransition(component, STATE.STARTED);
      await _persist(namespace, component, 'resumed', null);
      return component.toPublic();
    });
  }
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listComponents(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  function diagnostics(namespace = 'default') {
    return {
      components: (_index.get(namespace) || new Map()).size,
      totalComponents: _countAll(),
      started: _countState(STATE.STARTED),
      namespaces: _index.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    register,
    initialize,
    start,
    stop,
    restart,
    status,
    verify,
    health,
    // additive helpers
    suspend,
    resume,
    list,
    diagnostics,
    history,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createLifecycleService };
