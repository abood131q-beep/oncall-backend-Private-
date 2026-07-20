'use strict';

/**
 * Scheduler engine (Phase 14.3.3 §4/§5/§6) — the Kernel Service implementing the
 * Scheduler port. In-process only (no distributed scheduling, no external
 * queues). Deterministic and testable: time is injected via `clock()` and work
 * is advanced by `tick(now)`, so tests never depend on wall-clock timers. A
 * production driver can call `start(intervalMs)` to tick on an interval.
 *
 * Execution engine: a priority-ordered ready set, a concurrency-limited worker
 * pool, per-job timeout + cancellation (AbortController), execution isolation
 * (a throwing/timing-out job never affects others), retry with dead-letter, and
 * graceful shutdown. Lifecycle events are published ONLY through the
 * EventPublisher port.
 */

const { createJob, STATUS } = require('../../domain/scheduler/job');
const schedule = require('../../domain/scheduler/schedule');
const cron = require('../../domain/scheduler/cron');
const retryPolicy = require('../../domain/scheduler/retryPolicy');
const { createSchedulerEvent, SCHEDULER_EVENTS } = require('../../domain/scheduler/events');
const { createNullPublisher } = require('../shared/eventPublisher');

function createScheduler(deps = {}) {
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {}, debug() {} };
  const concurrency = deps.concurrency || 4;
  const setIntervalImpl = deps.setIntervalImpl || setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl || clearInterval;

  const records = new Map(); // jobId -> { job, handler, capabilities, control }
  const deadLetter = [];
  let running = 0;
  let _lastNow = clock();
  let _draining = false;
  let _timer = null;

  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      running: () => running,
      queueDepth: () => [...records.values()].filter((r) => r.job.isDue(_lastNow)).length,
    });
  }

  // ── timeout guard (rejects + aborts if the handler overruns) ───────────────
  function _withTimeout(promise, ms, ac) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          if (ac) ac.abort();
          const err = new Error(`job timed out after ${ms}ms`);
          err.__timeout = true;
          reject(err);
        }
      }, ms);
      Promise.resolve(promise).then(
        (v) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            resolve(v);
          }
        },
        (e) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            reject(e);
          }
        }
      );
    });
  }

  function _emit(type, job, extra = {}) {
    try {
      const event = createSchedulerEvent(
        type,
        { jobId: job.jobId, name: job.name, owner: job.owner, ...extra },
        { clock: () => new Date(clock()) }
      );
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('scheduler: event publish failed', e.message)
      );
    } catch (e) {
      log.error('scheduler: could not build event', e.message);
    }
  }

  function _register(jobSpec, planFields) {
    if (typeof jobSpec.handler !== 'function') {
      throw new Error('scheduler: job.handler must be a function');
    }
    const job = createJob({ ...jobSpec, ...planFields }, { clock });
    records.set(job.jobId, {
      job,
      handler: jobSpec.handler,
      capabilities: jobSpec.capabilities || [],
      control: { cancelled: false, abort: null },
    });
    if (metrics) metrics.recordScheduled();
    _emit(SCHEDULER_EVENTS.SCHEDULED, job, {
      scheduleType: job.scheduleType,
      nextRun: job.nextRun,
      priority: job.priority,
    });
    return job.jobId;
  }

  function _get(jobId) {
    const rec = records.get(jobId);
    if (!rec) throw new Error(`scheduler: job "${jobId}" not found`);
    return rec;
  }

  // ── ready-set selection (priority, then earliest nextRun, then createdAt) ──
  function _pickDue(now) {
    let best = null;
    for (const rec of records.values()) {
      const j = rec.job;
      if (j.status === STATUS.RUNNING || j.status === STATUS.PAUSED) continue;
      if (!j.isDue(now)) continue;
      if (
        !best ||
        j.priority > best.job.priority ||
        (j.priority === best.job.priority && j.nextRun < best.job.nextRun) ||
        (j.priority === best.job.priority &&
          j.nextRun === best.job.nextRun &&
          j.createdAt < best.job.createdAt)
      ) {
        best = rec;
      }
    }
    return best;
  }

  async function _execute(rec, now) {
    const job = rec.job;
    job.markRunning(now);
    running += 1;
    const startedAt = clock();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    rec.control.abort = () => ac && ac.abort();
    _emit(SCHEDULER_EVENTS.STARTED, job, { attempt: job.attempts });

    try {
      const ctx = {
        jobId: job.jobId,
        attempt: job.attempts,
        metadata: { ...job.metadata },
        signal: ac ? ac.signal : undefined,
        logger: log,
      };
      const runP = Promise.resolve().then(() => rec.handler(ctx));
      if (job.timeout > 0) await _withTimeout(runP, job.timeout, ac);
      else await runP;
      _onComplete(rec, clock(), clock() - startedAt);
    } catch (err) {
      if (rec.control.cancelled) {
        // Cancellation wins: never retried.
        job.markCancelled();
        if (metrics) metrics.recordCancelled();
        _emit(SCHEDULER_EVENTS.CANCELLED, job);
      } else {
        const isTimeout = Boolean(err && err.__timeout);
        if (isTimeout) {
          job.markTimedOut();
          if (metrics) metrics.recordTimedOut();
          _emit(SCHEDULER_EVENTS.TIMED_OUT, job, { attempt: job.attempts });
        }
        _applyFailure(rec, err, clock());
      }
    } finally {
      running -= 1;
    }
  }

  function _onComplete(rec, now, durationMs) {
    const job = rec.job;
    if (metrics) metrics.recordCompleted(durationMs);
    const next = schedule.nextRecurrence(job, now);
    if (next != null) {
      job.reschedule(next); // recurring: back to SCHEDULED for the next occurrence
    } else {
      job.markCompleted();
    }
    _emit(SCHEDULER_EVENTS.COMPLETED, job, {
      durationMs,
      recurring: next != null,
      nextRun: next,
    });
  }

  function _applyFailure(rec, err, now) {
    const job = rec.job;
    const decision = retryPolicy.decide(job.retryPolicy, job.retries);
    const error = err && err.message ? err.message : String(err);
    if (decision.retry) {
      job.markRetrying(now + decision.delayMs);
      if (metrics) metrics.recordRetry();
      _emit(SCHEDULER_EVENTS.RETRIED, job, {
        attempt: job.attempts,
        nextRun: job.nextRun,
        delayMs: decision.delayMs,
        error,
      });
    } else {
      job.markFailed();
      if (metrics) metrics.recordFailed();
      deadLetter.push({ jobId: job.jobId, name: job.name, owner: job.owner, error, at: now });
      _emit(SCHEDULER_EVENTS.FAILED, job, { error, attempts: job.attempts });
    }
  }

  // ── tick: drain the ready set honoring the concurrency limit ───────────────
  async function tick(nowArg) {
    const now = typeof nowArg === 'number' ? nowArg : clock();
    _lastNow = now;
    if (_draining) return { started: 0 };
    const active = new Set();
    let started = 0;
    const fill = () => {
      while (running < concurrency) {
        const rec = _pickDue(now);
        if (!rec) break;
        started += 1;
        const p = _execute(rec, now).finally(() => active.delete(p));
        active.add(p);
      }
    };
    fill();
    while (active.size > 0) {
      await Promise.race(active);
      fill();
    }
    return { started };
  }

  // ── public port ────────────────────────────────────────────────────────────
  function _normDate(d) {
    if (d instanceof Date) return d.getTime();
    if (typeof d === 'number') return d;
    throw new Error('scheduler: date must be a Date or ms epoch');
  }

  function scheduleJob(jobSpec) {
    const now = clock();
    let plan;
    if (jobSpec.cron) plan = schedule.planCron(now, jobSpec.cron);
    else if (typeof jobSpec.interval === 'number')
      plan = schedule.planInterval(now, jobSpec.interval);
    else plan = schedule.planOnce(now, jobSpec.scheduledAt);
    return _register(jobSpec, plan);
  }

  function scheduleAt(jobSpec, date) {
    return _register(jobSpec, schedule.planOnce(clock(), _normDate(date)));
  }

  function scheduleAfter(jobSpec, durationMs) {
    return _register(jobSpec, schedule.planDelayed(clock(), durationMs));
  }

  function scheduleRecurring(jobSpec, expression) {
    const now = clock();
    let plan;
    if (typeof expression === 'string') plan = schedule.planCron(now, expression);
    else if (expression && typeof expression.intervalMs === 'number')
      plan = schedule.planInterval(now, expression.intervalMs);
    else throw new Error('scheduler: recurring expression must be a cron string or { intervalMs }');
    return _register(jobSpec, plan);
  }

  function cancel(jobId) {
    const rec = records.get(jobId);
    if (!rec) return false;
    rec.control.cancelled = true;
    if (rec.job.status === STATUS.RUNNING && rec.control.abort) {
      rec.control.abort(); // best-effort in-flight cancellation
    } else {
      rec.job.markCancelled();
      if (metrics) metrics.recordCancelled();
      _emit(SCHEDULER_EVENTS.CANCELLED, rec.job);
    }
    return true;
  }

  function pause(jobId) {
    const rec = _get(jobId);
    if (rec.job.pause()) _emit(SCHEDULER_EVENTS.PAUSED, rec.job);
    return rec.job.status === STATUS.PAUSED;
  }

  function resume(jobId) {
    const rec = _get(jobId);
    if (rec.job.resume()) _emit(SCHEDULER_EVENTS.RESUMED, rec.job);
    return rec.job.status !== STATUS.PAUSED;
  }

  function exists(jobId) {
    return records.has(jobId);
  }

  function list() {
    return [...records.values()].map((r) => r.job.toModel());
  }

  function status(jobId) {
    const rec = records.get(jobId);
    return rec ? rec.job.status : null;
  }

  async function runNow(jobId) {
    const rec = _get(jobId);
    if (rec.job.status === STATUS.RUNNING)
      throw new Error(`scheduler: job "${jobId}" already running`);
    rec.control.cancelled = false;
    rec.job.status = STATUS.SCHEDULED;
    rec.job.nextRun = clock();
    await _execute(rec, clock());
    return rec.job.status;
  }

  // ── driver + graceful shutdown ─────────────────────────────────────────────
  function start(intervalMs = 1000) {
    if (_timer) return;
    _timer = setIntervalImpl(() => {
      tick().catch((e) => log.error('scheduler: tick failed', e.message));
    }, intervalMs);
    if (_timer && _timer.unref) _timer.unref();
  }

  function stop() {
    if (_timer) {
      clearIntervalImpl(_timer);
      _timer = null;
    }
  }

  async function shutdown() {
    stop();
    _draining = true;
    // Wait for in-flight jobs to settle (bounded polling; no new work admitted).
    while (running > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  return {
    // §1 port
    schedule: scheduleJob,
    scheduleAt,
    scheduleAfter,
    scheduleRecurring,
    cancel,
    pause,
    resume,
    exists,
    list,
    status,
    runNow,
    // engine control (deterministic tick + production driver)
    tick,
    start,
    stop,
    shutdown,
    // introspection
    deadLetter: () => deadLetter.map((d) => ({ ...d })),
    metrics: () => (metrics ? metrics.snapshot() : null),
    isValidCron: cron.isValid,
    STATUS,
  };
}

module.exports = { createScheduler };
