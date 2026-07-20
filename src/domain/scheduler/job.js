'use strict';

/**
 * Job entity (Phase 14.3.3 §2) — the scheduling aggregate. Identity = jobId.
 * Encapsulates its own status transitions so scheduling logic stays in the
 * domain (no business logic — purely the mechanics of a scheduled unit of work).
 *
 * Data fields: jobId, name, owner, priority, createdAt, scheduledAt, nextRun,
 * lastRun, status, retryPolicy, timeout, metadata, tags (+ internal retries).
 * The runtime handler function is NOT part of the model; the engine holds it.
 */

const retryPolicy = require('./retryPolicy');

const STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
  RETRYING: 'retrying',
});

// Higher number = higher priority (drained first).
const PRIORITY = Object.freeze({ low: 10, normal: 20, high: 30, critical: 40 });

const SCHEDULE_TYPE = Object.freeze({
  ONCE: 'once',
  DELAYED: 'delayed',
  INTERVAL: 'interval',
  CRON: 'cron',
});

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `job_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * @param {object} spec
 *   name (required), owner (required), priority?, retryPolicy?, timeout?,
 *   metadata?, tags?, scheduleType, nextRun (ms), scheduledAt (ms), interval?, cron?
 * @param {object} [opts] { clock: () => msEpoch, idFactory }
 */
function createJob(spec = {}, opts = {}) {
  if (!spec.name || typeof spec.name !== 'string') throw new Error('job: "name" is required');
  if (!spec.owner || typeof spec.owner !== 'string') throw new Error('job: "owner" is required');
  const clock = opts.clock || (() => Date.now());
  const idFactory = opts.idFactory || defaultId;
  const now = clock();

  const priority =
    typeof spec.priority === 'number' ? spec.priority : PRIORITY[spec.priority] || PRIORITY.normal;

  const job = {
    jobId: spec.jobId || idFactory(),
    name: spec.name,
    owner: spec.owner,
    priority,
    createdAt: now,
    scheduledAt: typeof spec.scheduledAt === 'number' ? spec.scheduledAt : now,
    nextRun: typeof spec.nextRun === 'number' ? spec.nextRun : now,
    lastRun: null,
    status: STATUS.SCHEDULED,
    retryPolicy: retryPolicy.normalize(spec.retryPolicy),
    timeout: typeof spec.timeout === 'number' ? spec.timeout : 0, // 0 = no timeout
    metadata: { ...(spec.metadata || {}) },
    tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
    // scheduling recurrence
    scheduleType: spec.scheduleType || SCHEDULE_TYPE.ONCE,
    interval: typeof spec.interval === 'number' ? spec.interval : null,
    cron: typeof spec.cron === 'string' ? spec.cron : null,
    // internal execution state
    retries: 0,
    attempts: 0,
    _statusBeforePause: null,

    // ── transitions (domain behavior) ──────────────────────────────────────
    isRecurring() {
      return (
        this.scheduleType === SCHEDULE_TYPE.INTERVAL || this.scheduleType === SCHEDULE_TYPE.CRON
      );
    },
    isDue(nowMs) {
      return (
        (this.status === STATUS.SCHEDULED || this.status === STATUS.RETRYING) &&
        this.nextRun <= nowMs
      );
    },
    markRunning(nowMs) {
      this.status = STATUS.RUNNING;
      this.lastRun = nowMs;
      this.attempts += 1;
    },
    markCompleted() {
      this.status = STATUS.COMPLETED;
    },
    markFailed() {
      this.status = STATUS.FAILED;
    },
    markTimedOut() {
      this.status = STATUS.TIMED_OUT;
    },
    markCancelled() {
      this.status = STATUS.CANCELLED;
    },
    markRetrying(nextRunMs) {
      this.retries += 1;
      this.nextRun = nextRunMs;
      this.status = STATUS.RETRYING;
    },
    reschedule(nextRunMs) {
      this.nextRun = nextRunMs;
      this.status = STATUS.SCHEDULED;
      this.retries = 0;
    },
    pause() {
      if (this.status === STATUS.PAUSED) return false;
      this._statusBeforePause = this.status;
      this.status = STATUS.PAUSED;
      return true;
    },
    resume() {
      if (this.status !== STATUS.PAUSED) return false;
      this.status = this._statusBeforePause || STATUS.SCHEDULED;
      this._statusBeforePause = null;
      return true;
    },
    /** Public, serializable view of the model (no handler, no functions). */
    toModel() {
      return {
        jobId: this.jobId,
        name: this.name,
        owner: this.owner,
        priority: this.priority,
        createdAt: this.createdAt,
        scheduledAt: this.scheduledAt,
        nextRun: this.nextRun,
        lastRun: this.lastRun,
        status: this.status,
        retryPolicy: this.retryPolicy,
        timeout: this.timeout,
        metadata: { ...this.metadata },
        tags: [...this.tags],
        scheduleType: this.scheduleType,
        retries: this.retries,
        attempts: this.attempts,
      };
    },
  };
  return job;
}

module.exports = { createJob, STATUS, PRIORITY, SCHEDULE_TYPE };
