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
    await storage.put({
      namespace: NS,
      collection: COLLECTION,
      key: instance.workflowId,
      value: instance.toModel(),
      metadata: { owner: instance.metadata.owner || null, definition: instance.definitionName },
    });
  }
  async function _load(workflowId) {
    const rec = await storage.get({ namespace: NS, collection: COLLECTION, key: workflowId });
    if (!rec) throw new WorkflowNotFoundError(`workflow "${workflowId}" not found`);
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
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('workflow: event publish failed', e.message)
      );
    } catch (e) {
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
    const from = instance.state;
    instance.transitionTo(toState, event, patch, clock());
    await _persist(instance);
    if (metrics) metrics.recordTransition();
    _emit(WORKFLOW_EVENTS.TRANSITIONED, instance, { from, event });
    _armTimeout(instance, def);
    if (def.isTerminal(toState)) await _finalize(instance, def);
    return instance;
  }

  async function _finalize(instance, def) {
    _cancelTimeout(instance.workflowId);
    if (def.isFailureState(instance.state)) {
      instance.fail(`reached failure state "${instance.state}"`, clock());
      if (metrics) metrics.recordFailed();
      await _persist(instance);
      _emit(WORKFLOW_EVENTS.FAILED, instance, { reason: instance.metadata.failureReason });
    } else {
      instance.complete(clock());
      if (metrics) metrics.recordCompleted();
      await _persist(instance);
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
    definitions: () => [...new Set([...definitions.values()])].map((d) => d.toModel()),
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createWorkflowEngine };
