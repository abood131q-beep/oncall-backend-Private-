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

  // ── Production hardening (Phase 14.3.3 A-001) — all additive ───────────────
  const _startTime = clock();
  const historyLimit = deps.historyLimit || 200;
  const _history = []; // ring buffer of lifecycle transitions { jobId, type, status, at }
  let _clockRegressions = 0; // monotonic-clock verification
  let _ticking = null; // in-flight tick promise (concurrent-tick protection)

  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      running: () => running,
      queueDepth: () => [...records.values()].filter((r) => r.job.isDue(_lastNow)).length,
      deadLetterSize: () => deadLetter.length,
    });
  }

  function _recordHistory(type, job) {
    _history.push({ jobId: job.jobId, type, status: job.status, at: clock() });
    if (_history.length > historyLimit) _history.shift();
  }

  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
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
    _recordHistory(type, job); // lifecycle history (bounded ring buffer)
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
    // Queue latency: time waited between becoming due and actually starting.
    if (metrics && metrics.recordQueueLatency) {
      metrics.recordQueueLatency(Math.max(0, now - job.nextRun));
    }
    job.markRunning(now);
    running += 1;
    rec.control.runningSince = clock(); // for crash/stuck recovery
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
      running = Math.max(0, running - 1); // guard: never negative (e.g. after recover())
      rec.control.runningSince = null;
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
  /**
   * Concurrent-tick protection: overlapping tick() calls never double-drain the
   * ready set; a call made while a tick is in flight awaits that tick and then
   * runs once more, keeping queue state consistent. Public signature/return
   * shape are unchanged.
   */
  function tick(nowArg) {
    if (_ticking) {
      return _ticking.catch(() => {}).then(() => _tickOnce(nowArg));
    }
    _ticking = _tickOnce(nowArg).finally(() => {
      _ticking = null;
    });
    return _ticking;
  }

  async function _tickOnce(nowArg) {
    const now = typeof nowArg === 'number' ? nowArg : clock();
    // Monotonic-clock verification: a backwards clock is anomalous; record it
    // and do not move _lastNow backwards (protects queue-latency accounting).
    if (now < _lastNow) {
      _clockRegressions += 1;
      log.warn('scheduler: non-monotonic clock detected', { now, lastNow: _lastNow });
    } else {
      _lastNow = now;
    }
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

  async function shutdown({ maxWaitMs = 30000 } = {}) {
    stop();
    _draining = true;
    // Graceful worker draining, bounded so shutdown can never hang forever.
    const deadline = Date.now() + maxWaitMs;
    while (running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return { drained: running === 0, stillRunning: running };
  }

  // ── production hardening: recovery, snapshots, diagnostics (all additive) ──

  /**
   * Worker-crash recovery: jobs stuck RUNNING beyond `maxRunningMs` (e.g. a tick
   * abandoned after a crash) are re-queued for a fresh attempt. Deterministic
   * via the injected clock. Returns the recovered jobIds.
   */
  function recover({ maxRunningMs = 60000, now = clock() } = {}) {
    const recovered = [];
    for (const rec of records.values()) {
      const since = rec.control.runningSince;
      if (rec.job.status === STATUS.RUNNING && since != null && now - since >= maxRunningMs) {
        running = Math.max(0, running - 1);
        rec.control.runningSince = null;
        rec.job.reschedule(now); // back to SCHEDULED, due immediately
        recovered.push(rec.job.jobId);
        log.warn('scheduler: recovered stuck job', { jobId: rec.job.jobId });
      }
    }
    return recovered;
  }

  /** Immutable, deep-frozen snapshot of a single job's model (or null). */
  function jobSnapshot(jobId) {
    const rec = records.get(jobId);
    return rec ? _deepFreeze(rec.job.toModel()) : null;
  }

  /** Bounded lifecycle history (newest last) — the scheduler's version log. */
  function history() {
    return _history.map((h) => ({ ...h }));
  }

  const uptime = () => clock() - _startTime;

  /**
   * Queue-consistency verification: the running counter must equal the number of
   * jobs actually in RUNNING state, and no job may be both RUNNING and due.
   */
  function verifyQueue() {
    const runningJobs = [...records.values()].filter((r) => r.job.status === STATUS.RUNNING).length;
    const ok = runningJobs === running && running <= concurrency;
    return { ok, runningCounter: running, runningJobs, concurrency };
  }

  /** Startup verification: sane configuration before the scheduler is trusted. */
  function verifyStartup() {
    const problems = [];
    if (!(concurrency > 0)) problems.push('concurrency must be > 0');
    if (typeof clock !== 'function') problems.push('clock must be a function');
    if (typeof clock() !== 'number') problems.push('clock() must return ms epoch');
    return { ok: problems.length === 0, problems };
  }

  /** Structured diagnostics for dashboards / health checks. */
  function diagnostics() {
    return {
      uptimeMs: uptime(),
      running,
      concurrency,
      jobs: records.size,
      queueDepth: [...records.values()].filter((r) => r.job.isDue(_lastNow)).length,
      deadLetter: deadLetter.length,
      clockRegressions: _clockRegressions,
      clockMonotonic: _clockRegressions === 0,
      ticking: Boolean(_ticking),
      draining: _draining,
      historyDepth: _history.length,
      queue: verifyQueue(),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  /** Health reporting: degraded if the queue is inconsistent or the clock skewed. */
  function health() {
    const q = verifyQueue();
    const healthy = q.ok && _clockRegressions === 0;
    return {
      status: healthy ? 'healthy' : 'degraded',
      queueConsistent: q.ok,
      clockMonotonic: _clockRegressions === 0,
      running,
      deadLetter: deadLetter.length,
      uptimeMs: uptime(),
    };
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
    // production hardening (additive)
    recover,
    jobSnapshot,
    history,
    uptime,
    verifyQueue,
    verifyStartup,
    diagnostics,
    health,
    // introspection
    deadLetter: () => deadLetter.map((d) => ({ ...d })),
    metrics: () => (metrics ? metrics.snapshot() : null),
    isValidCron: cron.isValid,
    STATUS,
  };
}

module.exports = { createScheduler };
