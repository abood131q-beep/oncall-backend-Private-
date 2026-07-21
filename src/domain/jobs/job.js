'use strict';

/**
 * Job (Phase 15.3 / ADR-032 §2) — PURE domain value object. A provider-agnostic,
 * deterministic background job with a lifecycle status, a retry policy, execution
 * history, and a content checksum for integrity. This is NOT BullMQ/RabbitMQ/
 * Sidekiq/Hangfire — those are provider/persistence details. Execution behavior
 * (queueing, retry, timeout, dead-letter) lives in the engine; this object owns
 * identity, payload, and status transitions.
 *
 * Fields: jobId, namespace, type, handler, payload, priority, status, retryPolicy,
 * attemptCount, maxAttempts, scheduledTime, startedTime, completedTime, failedTime,
 * timeout, correlationId, workflowId, metadata, dedupKey, idempotencyKey,
 * nextAttemptAt, lastError, deadLettered, history, seq, createdAt, updatedAt,
 * version, checksum.
 */

const { JobValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');
const { createRetryPolicy, policyFromModel } = require('./retryPolicy');

const STATUS = Object.freeze({
  CREATED: 'created',
  QUEUED: 'queued',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying',
  CANCELLED: 'cancelled',
  DEAD_LETTER: 'dead_letter',
});

const TERMINAL = new Set([STATUS.COMPLETED, STATUS.CANCELLED, STATUS.DEAD_LETTER]);
const PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  CRITICAL: 'critical',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `job_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(j) {
  return {
    namespace: j.namespace,
    type: j.type,
    handler: j.handler,
    payload: j.payload,
    priority: j.priority,
    retryPolicy: j.retryPolicy,
    maxAttempts: j.maxAttempts,
    scheduledTime: j.scheduledTime,
    timeout: j.timeout,
    correlationId: j.correlationId,
    workflowId: j.workflowId,
    metadata: j.metadata,
    dedupKey: j.dedupKey,
    idempotencyKey: j.idempotencyKey,
  };
}

function computeChecksum(j) {
  return checksum(stableStringify(definitionOf(j)));
}

/**
 * @param {object} spec { type (required), payload?, handler?, priority?, namespace?,
 *   retryPolicy?, maxAttempts?, scheduledTime?, timeout?, correlationId?,
 *   workflowId?, metadata?, dedupKey?, idempotencyKey?, jobId?, status?, seq? }
 * @param {object} [opts] { idFactory, clock }
 */
function createJob(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.type || typeof spec.type !== 'string') {
    throw new JobValidationError('job: "type" is required');
  }
  if (spec.payload !== undefined && typeof spec.payload === 'function') {
    throw new JobValidationError('job: "payload" must be serializable (not a function)');
  }
  const now = clock();
  const rp = spec.retryPolicy
    ? policyFromModel(
        typeof spec.retryPolicy.toModel === 'function'
          ? spec.retryPolicy.toModel()
          : spec.retryPolicy
      )
    : createRetryPolicy({ maxAttempts: spec.maxAttempts != null ? spec.maxAttempts : 1 });
  const maxAttempts = spec.maxAttempts != null ? Number(spec.maxAttempts) : rp.maxAttempts;
  const j = {
    jobId: spec.jobId || idFactory(),
    namespace: spec.namespace || 'default',
    type: spec.type,
    handler: spec.handler != null ? spec.handler : spec.type,
    payload: spec.payload !== undefined ? spec.payload : null,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    status: Object.values(STATUS).includes(spec.status) ? spec.status : STATUS.CREATED,
    retryPolicy: rp,
    attemptCount: spec.attemptCount || 0,
    maxAttempts,
    scheduledTime: spec.scheduledTime != null ? spec.scheduledTime : null,
    startedTime: spec.startedTime != null ? spec.startedTime : null,
    completedTime: spec.completedTime != null ? spec.completedTime : null,
    failedTime: spec.failedTime != null ? spec.failedTime : null,
    timeout: spec.timeout != null ? spec.timeout : null,
    correlationId: spec.correlationId != null ? spec.correlationId : null,
    workflowId: spec.workflowId != null ? spec.workflowId : null,
    metadata: { ...(spec.metadata || {}) },
    dedupKey: spec.dedupKey != null ? spec.dedupKey : null,
    idempotencyKey: spec.idempotencyKey != null ? spec.idempotencyKey : null,
    nextAttemptAt: spec.nextAttemptAt != null ? spec.nextAttemptAt : null,
    lastError: spec.lastError != null ? spec.lastError : null,
    deadLettered: Boolean(spec.deadLettered),
    history: Array.isArray(spec.history) ? [...spec.history] : [],
    seq: spec.seq != null ? spec.seq : 0,
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    version: spec.version || 1,

    isTerminal() {
      return TERMINAL.has(this.status);
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    _touch(nowMs) {
      this.updatedAt = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      return this;
    },
    markQueued(nowMs) {
      this.status = STATUS.QUEUED;
      return this._touch(nowMs);
    },
    markScheduled(nowMs) {
      this.status = STATUS.SCHEDULED;
      return this._touch(nowMs);
    },
    markRunning(nowMs) {
      this.status = STATUS.RUNNING;
      this.startedTime = typeof nowMs === 'number' ? nowMs : clock();
      this.attemptCount += 1;
      return this._touch(nowMs);
    },
    markCompleted(nowMs) {
      const at = typeof nowMs === 'number' ? nowMs : clock();
      this.status = STATUS.COMPLETED;
      this.completedTime = at;
      this.lastError = null;
      this.history.push({ attempt: this.attemptCount, status: 'completed', at });
      return this._touch(nowMs);
    },
    scheduleRetry(nextAt, reason, nowMs) {
      const at = typeof nowMs === 'number' ? nowMs : clock();
      this.status = STATUS.RETRYING;
      this.nextAttemptAt = nextAt;
      this.failedTime = at;
      this.lastError = reason || 'job failed';
      this.history.push({
        attempt: this.attemptCount,
        status: 'failed',
        reason: this.lastError,
        at,
      });
      return this._touch(nowMs);
    },
    markDeadLetter(reason, nowMs) {
      const at = typeof nowMs === 'number' ? nowMs : clock();
      this.status = STATUS.DEAD_LETTER;
      this.deadLettered = true;
      this.failedTime = at;
      this.lastError = reason || 'job failed';
      this.history.push({
        attempt: this.attemptCount,
        status: 'dead_letter',
        reason: this.lastError,
        at,
      });
      return this._touch(nowMs);
    },
    markCancelled(nowMs) {
      this.status = STATUS.CANCELLED;
      return this._touch(nowMs);
    },
    toModel() {
      return {
        jobId: this.jobId,
        namespace: this.namespace,
        type: this.type,
        handler: this.handler,
        payload: this.payload,
        priority: this.priority,
        status: this.status,
        retryPolicy: this.retryPolicy.toModel(),
        attemptCount: this.attemptCount,
        maxAttempts: this.maxAttempts,
        scheduledTime: this.scheduledTime,
        startedTime: this.startedTime,
        completedTime: this.completedTime,
        failedTime: this.failedTime,
        timeout: this.timeout,
        correlationId: this.correlationId,
        workflowId: this.workflowId,
        metadata: { ...this.metadata },
        dedupKey: this.dedupKey,
        idempotencyKey: this.idempotencyKey,
        nextAttemptAt: this.nextAttemptAt,
        lastError: this.lastError,
        deadLettered: this.deadLettered,
        history: this.history.map((h) => ({ ...h })),
        seq: this.seq,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        version: this.version,
        checksum: this.checksum,
      };
    },
    /** Public view — jobs are operational records, not secrets. */
    toPublic() {
      return this.toModel();
    },
  };
  j.checksum = spec.checksum || computeChecksum(j);
  return j;
}

function fromModel(model, opts = {}) {
  const j = createJob(model, opts);
  j.createdAt = model.createdAt;
  j.updatedAt = model.updatedAt;
  j.version = model.version;
  j.status = model.status;
  j.attemptCount = model.attemptCount || 0;
  j.checksum = model.checksum != null ? model.checksum : computeChecksum(j);
  return j;
}

module.exports = {
  createJob,
  fromModel,
  computeChecksum,
  stableStringify,
  STATUS,
  PRIORITY,
  TERMINAL,
};
