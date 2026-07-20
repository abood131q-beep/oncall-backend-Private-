'use strict';

/**
 * Workflow Engine (Phase 14.4 / ADR-023) — the first INTEGRATED kernel component.
 * It orchestrates the standalone kernel services through their PORTS only, never
 * their internals:
 *   • Storage (ADR-021)      — persists each workflow instance's state.
 *   • Lock (ADR-022)         — guards a workflow against concurrent modification.
 *   • Scheduler (ADR-020)    — arms per-state timeouts / deferred transitions.
 *   • Event Backbone (016)   — publishes state-transition lifecycle events.
 *   • Configuration (019)    — reads engine policies (e.g. lock lease).
 * Extensions interact through the SDK adapter. The engine adds NO business logic;
 * behavior lives entirely in the (declarative) workflow definition.
 *
 * Deterministic (injected clock) and additive: nothing here is on a hot path.
 */

const { createDefinition, TIMEOUT_EVENT } = require('../../domain/workflow/definition');
const { createInstance, fromModel } = require('../../domain/workflow/instance');
const {
  DefinitionError,
  TransitionError,
  GuardRejectedError,
  InvalidStateError,
  WorkflowNotFoundError,
} = require('../../domain/workflow/errors');
const { WORKFLOW_EVENTS, createWorkflowEvent } = require('../../domain/workflow/events');
const { createNullPublisher } = require('../shared/eventPublisher');

const NS = 'workflow';
const COLLECTION = 'instances';

function createWorkflowEngine(deps = {}) {
  const storage = deps.storage;
  if (!storage || typeof storage.get !== 'function' || typeof storage.put !== 'function') {
    throw new Error('workflow: a Storage kernel (get/put) is required');
  }
  const lock = deps.lock || null; // Lock kernel (optional but recommended)
  const scheduler = deps.scheduler || null; // Scheduler kernel (optional)
  const config = deps.config || null; // Configuration kernel (optional)
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const engineId = deps.engineId || 'workflow-engine';

  const definitions = new Map(); // name@version -> definition
  const _chains = new Map(); // workflowId -> serialization promise
  const _timers = new Map(); // workflowId -> scheduler jobId

  // Production hardening (A-001) — all additive.
  const historyLimit = deps.historyLimit || 1000; // transition-history ring buffer cap
  const engineHistoryLimit = deps.engineHistoryLimit || 500;
  const _engineHistory = []; // engine lifecycle ring buffer { workflowId, type, at }

  function _recordEngineHistory(type, workflowId) {
    _engineHistory.push({ workflowId, type, at: clock() });
    if (_engineHistory.length > engineHistoryLimit) _engineHistory.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  const lockLeaseMs = () => {
    const v =
      config && typeof config.get === 'function' ? config.get('workflow.lockLeaseMs') : null;
    return typeof v === 'number' && v > 0 ? v : 30000;
  };

  // ── registration ────────────────────────────────────────────────────────────
  function register(defOrSpec) {
    const def = defOrSpec && defOrSpec.key ? defOrSpec : createDefinition(defOrSpec);
    definitions.set(def.key(), def);
    definitions.set(def.name, def); // latest-by-name convenience
    return def;
  }
  function _resolve(spec) {
    if (spec.definition) return register(spec.definition);
    const key = spec.definitionVersion
      ? `${spec.definitionName}@${spec.definitionVersion}`
      : spec.definitionName;
    const def = definitions.get(key);
    if (!def) throw new DefinitionError(`workflow: definition "${key}" is not registered`);
    return def;
  }

  // ── serialization + lock guard (concurrent-modification protection) ──────────
  function _withWorkflow(workflowId, fn) {
    const prev = _chains.get(workflowId) || Promise.resolve();
    const run = prev.then(
      () => _guarded(workflowId, fn),
      () => _guarded(workflowId, fn)
    );
    _chains.set(
      workflowId,
      run.then(
        () => {},
        () => {}
      )
    );
    return run;
  }
  async function _guarded(workflowId, fn) {
    if (!lock) return fn();
    const held = await lock.tryAcquire({
      namespace: NS,
      lockId: workflowId,
      ownerId: engineId,
      leaseMs: lockLeaseMs(),
    });
    if (!held) {
      if (metrics && metrics.recordLockConflict) metrics.recordLockConflict();
      throw new InvalidStateError(`workflow "${workflowId}" is being modified concurrently`);
    }
    try {
      return await fn();
    } finally {
      await lock.release({ namespace: NS, lockId: workflowId, ownerId: engineId }).catch(() => {});
    }
  }

  // ── persistence (Storage kernel) ─────────────────────────────────────────────
  async function _persist(instance) {
    try {
      await storage.put({
        namespace: NS,
        collection: COLLECTION,
        key: instance.workflowId,
        value: instance.toModel(),
        metadata: { owner: instance.metadata.owner || null, definition: instance.definitionName },
      });
    } catch (e) {
      if (metrics && metrics.recordStorageFailure) metrics.recordStorageFailure();
      throw e;
    }
  }

  /** Detect a structurally corrupt persisted record before trusting it. */
  function _assertNotCorrupt(workflowId, model) {
    const problems = [];
    if (!model || typeof model !== 'object') problems.push('record is not an object');
    else {
      if (!model.definitionName) problems.push('missing definitionName');
      if (!model.state) problems.push('missing state');
      if (!model.status) problems.push('missing status');
      if (!Number.isInteger(model.version)) problems.push('missing/invalid version');
    }
    if (problems.length) {
      throw new InvalidStateError(`workflow "${workflowId}" record is corrupt`, { problems });
    }
  }

  async function _load(workflowId) {
    let rec;
    try {
      rec = await storage.get({ namespace: NS, collection: COLLECTION, key: workflowId });
    } catch (e) {
      if (metrics && metrics.recordStorageFailure) metrics.recordStorageFailure();
      throw e;
    }
    if (!rec) throw new WorkflowNotFoundError(`workflow "${workflowId}" not found`);
    _assertNotCorrupt(workflowId, rec.value);
    const instance = fromModel(rec.value, { clock });
    const key = `${instance.definitionName}@${instance.definitionVersion}`;
    const def = definitions.get(key) || definitions.get(instance.definitionName);
    if (!def) throw new DefinitionError(`workflow: definition "${key}" not registered`);
    return { instance, def };
  }

  // ── events (Event Backbone) ──────────────────────────────────────────────────
  function _emit(type, instance, extra = {}) {
    try {
      const event = createWorkflowEvent(
        type,
        {
          workflowId: instance.workflowId,
          definition: instance.definitionName,
          state: instance.state,
          status: instance.status,
          ...extra,
        },
        { clock: () => new Date(clock()) }
      );
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('workflow: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('workflow: could not build event', e.message);
    }
  }

  // ── timeouts (Scheduler kernel) ──────────────────────────────────────────────
  function _cancelTimeout(workflowId) {
    const jobId = _timers.get(workflowId);
    if (jobId && scheduler) scheduler.cancel(jobId);
    _timers.delete(workflowId);
  }
  function _armTimeout(instance, def) {
    _cancelTimeout(instance.workflowId);
    const to = def.timeoutFor(instance.state);
    if (!to || !scheduler || !instance.isRunning()) return;
    const wfId = instance.workflowId;
    const atState = instance.state;
    const atVersion = instance.version;
    const jobId = scheduler.scheduleAfter(
      {
        name: `wf-timeout:${wfId}`,
        owner: 'workflow',
        handler: () =>
          _onTimeout(wfId, atState, atVersion).catch((e) =>
            log.error('workflow: timeout handler failed', e.message)
          ),
      },
      to.afterMs
    );
    _timers.set(wfId, jobId);
  }

  async function _onTimeout(workflowId, expectedState, expectedVersion) {
    return _withWorkflow(workflowId, async () => {
      const { instance, def } = await _load(workflowId);
      if (
        !instance.isRunning() ||
        instance.state !== expectedState ||
        instance.version !== expectedVersion
      ) {
        return; // superseded by a real transition — ignore the stale timer
      }
      const to = def.timeoutFor(instance.state);
      if (!to) return;
      if (metrics) metrics.recordTimeout();
      _emit(WORKFLOW_EVENTS.TIMED_OUT, instance, { from: instance.state, to: to.to });
      await _commit(instance, def, TIMEOUT_EVENT, to.to, null);
    });
  }

  // ── the transition commit (shared by signal + timeout) ───────────────────────
  async function _commit(instance, def, event, toState, patch) {
    const started = Date.now();
    const from = instance.state;
    instance.transitionTo(toState, event, patch, clock());
    // Transition-history ring buffer: keep the most recent entries bounded.
    if (instance.history.length > historyLimit) {
      instance.history = instance.history.slice(-historyLimit);
    }
    await _persist(instance);
    if (metrics) {
      metrics.recordTransition();
      if (metrics.recordTransitionLatency) metrics.recordTransitionLatency(Date.now() - started);
    }
    _recordEngineHistory(WORKFLOW_EVENTS.TRANSITIONED, instance.workflowId);
    _emit(WORKFLOW_EVENTS.TRANSITIONED, instance, { from, event });
    _armTimeout(instance, def);
    if (def.isTerminal(toState)) await _finalize(instance, def);
    return instance;
  }

  async function _finalize(instance, def) {
    _cancelTimeout(instance.workflowId);
    if (metrics && metrics.recordWorkflowDuration && instance.createdAt != null) {
      metrics.recordWorkflowDuration(clock() - instance.createdAt);
    }
    if (def.isFailureState(instance.state)) {
      instance.fail(`reached failure state "${instance.state}"`, clock());
      if (metrics) metrics.recordFailed();
      await _persist(instance);
      _recordEngineHistory(WORKFLOW_EVENTS.FAILED, instance.workflowId);
      _emit(WORKFLOW_EVENTS.FAILED, instance, { reason: instance.metadata.failureReason });
    } else {
      instance.complete(clock());
      if (metrics) metrics.recordCompleted();
      await _persist(instance);
      _recordEngineHistory(WORKFLOW_EVENTS.COMPLETED, instance.workflowId);
      _emit(WORKFLOW_EVENTS.COMPLETED, instance);
    }
  }

  // ── public API ────────────────────────────────────────────────────────────
  function start(spec = {}) {
    const def = _resolve(spec);
    const instance = createInstance(
      {
        workflowId: spec.workflowId,
        definitionName: def.name,
        definitionVersion: def.version,
        state: def.initial,
        context: spec.input,
        metadata: spec.metadata,
      },
      { clock, idFactory: deps.idFactory }
    );
    return _withWorkflow(instance.workflowId, () =>
      metricsTime(async () => {
        await _persist(instance);
        if (metrics) metrics.recordStart();
        _recordEngineHistory(WORKFLOW_EVENTS.STARTED, instance.workflowId);
        _emit(WORKFLOW_EVENTS.STARTED, instance);
        _armTimeout(instance, def);
        if (def.isTerminal(instance.state)) await _finalize(instance, def);
        return instance.toModel();
      })
    );
  }

  function signal(spec = {}) {
    const { workflowId, event, payload } = spec;
    if (!workflowId) throw new InvalidStateError('workflow: "workflowId" required');
    if (!event) throw new InvalidStateError('workflow: "event" required');
    return _withWorkflow(workflowId, () =>
      metricsTime(async () => {
        const { instance, def } = await _load(workflowId);
        if (!instance.isRunning()) {
          throw new InvalidStateError(
            `workflow "${workflowId}" is ${instance.status}, not running`
          );
        }
        const t = def.findTransition(instance.state, event);
        if (!t) {
          throw new TransitionError(
            `workflow "${workflowId}": no transition for (${instance.state}, ${event})`
          );
        }
        if (t.guard) {
          const ok = await t.guard(instance.context, payload);
          if (!ok)
            throw new GuardRejectedError(`workflow "${workflowId}": guard rejected "${event}"`);
        }
        const patch = t.action ? await t.action(instance.context, payload) : null;
        await _commit(instance, def, event, t.to, patch);
        return instance.toModel();
      })
    );
  }

  function cancel(spec = {}) {
    const workflowId = typeof spec === 'string' ? spec : spec.workflowId;
    return _withWorkflow(workflowId, () =>
      metricsTime(async () => {
        const { instance } = await _load(workflowId);
        if (!instance.isRunning() && instance.status !== 'suspended') return instance.toModel();
        instance.cancel(clock());
        _cancelTimeout(workflowId);
        await _persist(instance);
        if (metrics) metrics.recordCancelled();
        _recordEngineHistory(WORKFLOW_EVENTS.CANCELLED, instance.workflowId);
        _emit(WORKFLOW_EVENTS.CANCELLED, instance);
        return instance.toModel();
      })
    );
  }

  async function get(workflowId) {
    const rec = await storage.get({ namespace: NS, collection: COLLECTION, key: workflowId });
    return rec ? rec.value : null;
  }

  async function list(spec = {}) {
    const recs = await storage.list({ namespace: NS, collection: COLLECTION });
    let out = recs.map((r) => r.value);
    if (spec.definitionName) out = out.filter((m) => m.definitionName === spec.definitionName);
    if (spec.status) out = out.filter((m) => m.status === spec.status);
    if (spec.owner) out = out.filter((m) => m.metadata && m.metadata.owner === spec.owner);
    return out;
  }

  async function health() {
    return {
      ok: true,
      engineId,
      definitions: [...new Set([...definitions.values()].map((d) => d.key()))],
      wiring: {
        storage: Boolean(storage),
        lock: Boolean(lock),
        scheduler: Boolean(scheduler),
        config: Boolean(config),
        publisher: Boolean(publisher),
      },
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── production hardening: snapshots, verification, recovery, diagnostics ────

  /** Immutable, deep-frozen snapshot of a workflow instance (or null). */
  async function snapshot(workflowId) {
    const model = await get(workflowId);
    return model ? _deepFreeze(model) : null;
  }

  /** Startup verification: sane wiring before the engine is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!storage) problems.push('storage kernel is required');
    if (typeof clock !== 'function' || typeof clock() !== 'number') {
      problems.push('clock must return a numeric ms epoch');
    }
    if (definitions.size === 0) problems.push('no workflow definitions registered (warning)');
    return { ok: problems.filter((p) => !p.endsWith('(warning)')).length === 0, problems };
  }

  /**
   * Transition-integrity verification for one workflow: the state must be a
   * declared state, and the recorded history must form a contiguous chain that
   * ends at the current state. Detects corruption or tampering.
   */
  async function verifyWorkflow(workflowId) {
    const issues = [];
    let model;
    try {
      model = await get(workflowId);
    } catch (e) {
      return { ok: false, issues: [e.message] };
    }
    if (!model) return { ok: false, issues: ['not found'] };
    // Structural corruption check first (defensive — record may be malformed).
    try {
      _assertNotCorrupt(model.workflowId, model);
    } catch (e) {
      return { ok: false, issues: (e.details && e.details.problems) || [e.message] };
    }
    if (!Array.isArray(model.history)) return { ok: false, issues: ['missing history'] };
    const def =
      definitions.get(`${model.definitionName}@${model.definitionVersion}`) ||
      definitions.get(model.definitionName);
    if (!def) issues.push(`definition "${model.definitionName}" not registered`);
    if (def && !def.isState(model.state))
      issues.push(`current state "${model.state}" is not declared`);
    // History chain contiguity.
    for (let i = 1; i < model.history.length; i++) {
      if (model.history[i].from !== model.history[i - 1].to) {
        issues.push(`history discontinuity at index ${i}`);
      }
    }
    if (model.history.length && model.status === 'running') {
      const last = model.history[model.history.length - 1];
      if (last.to !== model.state) issues.push('current state does not match last history entry');
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Workflow recovery + scheduler reconciliation: after a restart, re-arm the
   * timeout timer for every running workflow whose current state declares one
   * (in-memory timers do not survive a restart). Corrupt records are reported,
   * not fatal. Deterministic.
   */
  async function recover() {
    const recovered = [];
    const corrupt = [];
    let recs = [];
    try {
      recs = await storage.list({ namespace: NS, collection: COLLECTION });
    } catch (e) {
      if (metrics && metrics.recordStorageFailure) metrics.recordStorageFailure();
      return { ok: false, error: e.message, recovered, corrupt };
    }
    for (const rec of recs) {
      const model = rec.value;
      try {
        _assertNotCorrupt(model && model.workflowId, model);
      } catch (e) {
        corrupt.push({
          workflowId: model && model.workflowId,
          issues: e.details && e.details.problems,
        });
        void e;
        continue;
      }
      if (model.status !== 'running') continue;
      const def =
        definitions.get(`${model.definitionName}@${model.definitionVersion}`) ||
        definitions.get(model.definitionName);
      if (!def || !def.timeoutFor(model.state)) continue;
      const instance = fromModel(model, { clock });
      _armTimeout(instance, def);
      if (metrics && metrics.recordSchedulerReconciliation) metrics.recordSchedulerReconciliation();
      recovered.push(model.workflowId);
    }
    return { ok: true, recovered, corrupt };
  }

  /** Structured diagnostics for dashboards / health checks. */
  function diagnostics() {
    return {
      engineId,
      wiring: {
        storage: Boolean(storage),
        lock: Boolean(lock),
        scheduler: Boolean(scheduler),
        config: Boolean(config),
        publisher: Boolean(publisher),
      },
      definitions: definitions.size,
      activeTimers: _timers.size,
      activeChains: _chains.size,
      engineHistoryDepth: _engineHistory.length,
      startup: verifyStartup(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  /** Bounded engine lifecycle history (newest last). */
  function history() {
    return _engineHistory.map((h) => ({ ...h }));
  }

  function metricsTime(fn) {
    return metrics && metrics.timeOp ? metrics.timeOp(fn) : fn();
  }

  return {
    register,
    start,
    signal,
    cancel,
    get,
    list,
    health,
    // production hardening (additive)
    snapshot,
    verifyStartup,
    verifyWorkflow,
    recover,
    diagnostics,
    history,
    definitions: () => [...new Set([...definitions.values()])].map((d) => d.toModel()),
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createWorkflowEngine };
