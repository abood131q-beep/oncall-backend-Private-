'use strict';

/**
 * Workflow Instance (Phase 14.4 / ADR-023) — the running-process aggregate.
 * Identity = workflowId. Encapsulates its own DETERMINISTIC state transitions
 * and history; holds the process `context` (data) but NO business logic. The
 * engine persists `toModel()` via the Storage kernel and rehydrates via
 * `fromModel`.
 */

const STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SUSPENDED: 'suspended',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `wf_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function createInstance(spec = {}, opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const idFactory = opts.idFactory || defaultId;
  const now = clock();
  if (!spec.definitionName) throw new Error('instance: "definitionName" required');
  if (!spec.state) throw new Error('instance: initial "state" required');
  return {
    workflowId: spec.workflowId || idFactory(),
    definitionName: spec.definitionName,
    definitionVersion: spec.definitionVersion || 1,
    state: spec.state,
    status: spec.status || STATUS.RUNNING,
    context: { ...(spec.context || {}) },
    metadata: { ...(spec.metadata || {}) },
    version: spec.version || 1,
    history: spec.history ? [...spec.history] : [],
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,

    transitionTo(toState, event, contextPatch, now2) {
      this.history.push({ from: this.state, to: toState, event, at: now2, version: this.version });
      this.state = toState;
      if (contextPatch && typeof contextPatch === 'object') {
        this.context = { ...this.context, ...contextPatch };
      }
      this.version += 1;
      this.updatedAt = now2;
      return this;
    },
    complete(now2) {
      this.status = STATUS.COMPLETED;
      this.version += 1;
      this.updatedAt = now2;
      return this;
    },
    fail(reason, now2) {
      this.status = STATUS.FAILED;
      this.metadata = { ...this.metadata, failureReason: reason };
      this.version += 1;
      this.updatedAt = now2;
      return this;
    },
    cancel(now2) {
      this.status = STATUS.CANCELLED;
      this.version += 1;
      this.updatedAt = now2;
      return this;
    },
    suspend(now2) {
      if (this.status !== STATUS.RUNNING) return false;
      this.status = STATUS.SUSPENDED;
      this.version += 1;
      this.updatedAt = now2;
      return true;
    },
    resume(now2) {
      if (this.status !== STATUS.SUSPENDED) return false;
      this.status = STATUS.RUNNING;
      this.version += 1;
      this.updatedAt = now2;
      return true;
    },
    isRunning() {
      return this.status === STATUS.RUNNING;
    },
    toModel() {
      return {
        workflowId: this.workflowId,
        definitionName: this.definitionName,
        definitionVersion: this.definitionVersion,
        state: this.state,
        status: this.status,
        context: { ...this.context },
        metadata: { ...this.metadata },
        version: this.version,
        history: this.history.map((h) => ({ ...h })),
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
      };
    },
  };
}

/** Rehydrate an instance from a persisted model (Storage kernel). */
function fromModel(model, opts = {}) {
  return createInstance({ ...model }, opts);
}

module.exports = { createInstance, fromModel, STATUS };
