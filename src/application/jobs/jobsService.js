'use strict';

/**
 * Background Jobs Service (Phase 15.3 / ADR-032) — the Background Jobs Kernel.
 * Platform-wide, deterministic asynchronous job execution, retries, scheduling
 * integration, and failure recovery. This is NOT BullMQ/RabbitMQ/Sidekiq/Hangfire
 * — those are provider/persistence details.
 *
 * Providers persist jobs; ALL execution logic lives here: deterministic queue
 * ordering (priority then FIFO), priority scheduling, retry with backoff, timeout
 * detection, cancellation, failure recovery, dead-letter queue, duplicate
 * detection, idempotency, execution history, and job verification. Lifecycle events
 * flow ONLY through the EventPublisher port. Deterministic + tick-driven (injected
 * clock; no wall-clock timers). Per-job mutations are atomic via a serialization
 * mutex.
 */

const { createJob, fromModel, STATUS } = require('../../domain/jobs/job');
const { JOB_EVENTS, createJobEvent } = require('../../domain/jobs/events');
const { JobValidationError, HandlerError } = require('../../domain/jobs/errors');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createJobsService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _handlers = new Map(); // type -> { handler, defaults }
  const _statusIndex = new Map(); // namespace -> Map(jobId -> status)
  const _dedup = new Map(); // namespace -> Map(dedupKey -> jobId)
  const _idem = new Map(); // namespace -> Map(idempotencyKey -> jobId of completed)
  let _seqCounter = 0;

  function _mapFor(map, ns) {
    if (!map.has(ns)) map.set(ns, new Map());
    return map.get(ns);
  }
  function _indexStatus(ns, id, status) {
    _mapFor(_statusIndex, ns).set(id, status);
  }
  function _countStatus(pred) {
    let n = 0;
    for (const m of _statusIndex.values()) for (const s of m.values()) if (pred(s)) n += 1;
    return n;
  }
  function _countAll() {
    let n = 0;
    for (const m of _statusIndex.values()) n += m.size;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      registered: () => _handlers.size,
      queued: () => _countStatus((s) => s === 'queued' || s === 'scheduled' || s === 'retrying'),
      running: () => _countStatus((s) => s === 'running'),
      deadLetter: () => _countStatus((s) => s === 'dead_letter'),
    });
  }

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
      const event = createJobEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('jobs: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('jobs: could not build event', e.message);
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

  async function _persist(job) {
    await _safe(() => provider.putJob(job.namespace, job.toModel()));
    _indexStatus(job.namespace, job.jobId, job.status);
  }

  // ── §1 register (handler for a type) ───────────────────────────────────────────
  function register(spec = {}) {
    const type = spec.type;
    if (!type || typeof type !== 'string') {
      throw new JobValidationError('jobs: register requires a "type"');
    }
    if (typeof spec.handler !== 'function') {
      throw new JobValidationError('jobs: register requires a "handler" function');
    }
    _handlers.set(type, {
      handler: spec.handler,
      defaults: {
        maxAttempts: spec.maxAttempts,
        timeout: spec.timeout,
        retryPolicy: spec.retryPolicy,
        priority: spec.priority,
      },
    });
    _emit(JOB_EVENTS.REGISTERED, { type });
    return { type, registered: true };
  }

  function _dedupKeyOf(job) {
    return job.dedupKey != null ? String(job.dedupKey) : null;
  }

  // Create + dedup/idempotency + persist. Returns { job, duplicate|idempotent, existing }.
  async function _create(spec, opts) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const type = spec.type;
    if (!type) throw new JobValidationError('jobs: "type" is required');
    const entry = _handlers.get(type);
    if (!entry) throw new HandlerError(`jobs: no handler registered for type "${type}"`);

    // Idempotency: a prior completed job with the same key short-circuits.
    if (spec.idempotencyKey != null) {
      const priorId = _mapFor(_idem, namespace).get(String(spec.idempotencyKey));
      if (priorId) {
        const prior = await _safe(() => provider.getJob(namespace, priorId));
        if (prior && prior.status === 'completed') {
          if (metrics) metrics.recordDuplicate();
          return { job: null, idempotent: true, existing: prior };
        }
      }
    }

    const merged = {
      ...entry.defaults,
      ...spec,
      namespace,
      seq: _seqCounter++,
    };
    const job = createJob(merged, { clock, idFactory: idOpts.idFactory });

    // Duplicate detection: a live (non-terminal) job with the same dedupKey.
    const key = _dedupKeyOf(job);
    if (key) {
      const bucket = _mapFor(_dedup, namespace);
      const existingId = bucket.get(key);
      if (existingId) {
        const existing = await _safe(() => provider.getJob(namespace, existingId));
        if (existing && !['completed', 'cancelled', 'dead_letter'].includes(existing.status)) {
          if (metrics) metrics.recordDuplicate();
          return { job: null, duplicate: true, existing };
        }
      }
      bucket.set(key, job.jobId);
    }
    return { job, duplicate: false, existing: null };
  }

  // ── §1 enqueue (ready to run) ───────────────────────────────────────────────────
  function enqueue(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const created = await _create(spec, { namespace });
      if (created.duplicate || created.idempotent) return created.existing;
      const job = created.job;
      job.markQueued(clock());
      await _persist(job);
      if (metrics) metrics.recordEnqueued();
      _recordLifecycle('queued', namespace, job.jobId);
      _emit(JOB_EVENTS.QUEUED, {
        jobId: job.jobId,
        namespace,
        type: job.type,
        priority: job.priority,
        correlationId: job.correlationId,
        workflowId: job.workflowId,
      });
      return job.toModel();
    })();
  }

  // ── §1 schedule (future run) ────────────────────────────────────────────────────
  function schedule(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const now = clock();
      const scheduledTime =
        spec.scheduledTime != null
          ? spec.scheduledTime
          : spec.delayMs != null
            ? now + spec.delayMs
            : null;
      if (scheduledTime == null) {
        throw new JobValidationError('jobs: schedule requires scheduledTime or delayMs');
      }
      const created = await _create({ ...spec, scheduledTime }, { namespace });
      if (created.duplicate || created.idempotent) return created.existing;
      const job = created.job;
      job.markScheduled(now);
      await _persist(job);
      if (metrics) metrics.recordEnqueued();
      _recordLifecycle('scheduled', namespace, job.jobId);
      _emit(JOB_EVENTS.QUEUED, {
        jobId: job.jobId,
        namespace,
        type: job.type,
        scheduledTime,
      });
      return job.toModel();
    })();
  }

  async function _handleFailure(job, reason, now) {
    if (metrics) metrics.recordFailed();
    if (job.retryPolicy.shouldRetry(job.attemptCount)) {
      const delay = job.retryPolicy.nextDelayMs(job.attemptCount);
      job.scheduleRetry(now + delay, reason, now);
      await _persist(job);
      if (metrics) metrics.recordRetried();
      _emit(JOB_EVENTS.FAILED, {
        jobId: job.jobId,
        namespace: job.namespace,
        type: job.type,
        reason,
        attempt: job.attemptCount,
        willRetry: true,
      });
      _emit(JOB_EVENTS.RETRIED, {
        jobId: job.jobId,
        namespace: job.namespace,
        type: job.type,
        nextAttemptAt: job.nextAttemptAt,
        attempt: job.attemptCount,
      });
    } else {
      job.markDeadLetter(reason, now);
      await _persist(job);
      _recordLifecycle('dead_letter', job.namespace, job.jobId);
      _emit(JOB_EVENTS.FAILED, {
        jobId: job.jobId,
        namespace: job.namespace,
        type: job.type,
        reason,
        attempt: job.attemptCount,
        willRetry: false,
        deadLettered: true,
      });
    }
  }

  async function _runJob(model, now) {
    const namespace = model.namespace;
    return _withLock(`${namespace}::${model.jobId}`, async () => {
      const fresh = await _safe(() => provider.getJob(namespace, model.jobId));
      if (!fresh || !['queued', 'scheduled', 'retrying'].includes(fresh.status)) return null;
      const job = fromModel(fresh, { clock });
      job.markRunning(now);
      await _persist(job);
      _emit(JOB_EVENTS.STARTED, {
        jobId: job.jobId,
        namespace,
        type: job.type,
        attempt: job.attemptCount,
      });

      const entry = _handlers.get(job.type);
      if (!entry) {
        await _handleFailure(job, `no handler for type "${job.type}"`, now);
        return job;
      }
      const start = clock();
      try {
        await entry.handler(job.payload, {
          jobId: job.jobId,
          namespace,
          attempt: job.attemptCount,
          metadata: job.metadata,
        });
        const done = clock();
        if (metrics) metrics.recordLatency(done - start);
        // Timeout detection: a handler that ran past its budget is a failure.
        if (job.timeout != null && done - job.startedTime > job.timeout) {
          await _handleFailure(job, 'timeout', done);
          return job;
        }
        job.markCompleted(done);
        if (job.idempotencyKey != null) {
          _mapFor(_idem, namespace).set(String(job.idempotencyKey), job.jobId);
        }
        await _persist(job);
        if (metrics) metrics.recordCompleted();
        _recordLifecycle('completed', namespace, job.jobId);
        _emit(JOB_EVENTS.COMPLETED, {
          jobId: job.jobId,
          namespace,
          type: job.type,
          attempt: job.attemptCount,
        });
      } catch (e) {
        if (metrics) metrics.recordLatency(clock() - start);
        await _handleFailure(job, e && e.message ? e.message : 'handler error', clock());
      }
      return job;
    });
  }

  // ── tick: run due jobs (deterministic priority-then-FIFO ordering) ────────────────
  function tick(nowArg) {
    return (async () => {
      const now = typeof nowArg === 'number' ? nowArg : clock();
      const summary = {
        processed: 0,
        completed: 0,
        failed: 0,
        retried: 0,
        deadLetter: 0,
        timedOut: 0,
      };

      // Recovery pass: jobs stuck RUNNING past their timeout become failures.
      for (const [namespace, statuses] of _statusIndex) {
        for (const [id, status] of statuses) {
          if (status !== 'running') continue;
          const model = await _safe(() => provider.getJob(namespace, id));
          if (!model || model.status !== 'running' || model.timeout == null) continue;
          if (now - model.startedTime > model.timeout) {
            await _withLock(`${namespace}::${id}`, async () => {
              const fresh = await _safe(() => provider.getJob(namespace, id));
              if (!fresh || fresh.status !== 'running') return;
              const job = fromModel(fresh, { clock });
              summary.timedOut += 1;
              await _handleFailure(job, 'timeout', now);
            });
          }
        }
      }

      // Collect due, then order by priority desc, seq asc (deterministic).
      const due = [];
      for (const [namespace, statuses] of _statusIndex) {
        for (const [id, status] of statuses) {
          if (!['queued', 'scheduled', 'retrying'].includes(status)) continue;
          const model = await _safe(() => provider.getJob(namespace, id));
          if (!model) continue;
          const ready =
            (status === 'queued' && (model.scheduledTime == null || model.scheduledTime <= now)) ||
            (status === 'scheduled' && model.scheduledTime != null && model.scheduledTime <= now) ||
            (status === 'retrying' && model.nextAttemptAt != null && model.nextAttemptAt <= now);
          if (ready) due.push(model);
        }
      }
      due.sort((a, b) => b.priority - a.priority || a.seq - b.seq);

      for (const model of due) {
        const job = await _runJob(model, now);
        if (!job) continue;
        summary.processed += 1;
        if (job.status === 'completed') summary.completed += 1;
        else if (job.status === 'dead_letter') summary.deadLetter += 1;
        else if (job.status === 'retrying') summary.retried += 1;
        else if (job.status === 'failed') summary.failed += 1;
      }
      return summary;
    })();
  }

  // ── §1 cancel ────────────────────────────────────────────────────────────────────
  function cancel(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.jobId;
    return _withLock(`${namespace}::${id}`, async () => {
      const model = await _safe(() => provider.getJob(namespace, id));
      if (!model) return false;
      const job = fromModel(model, { clock });
      if (job.isTerminal() || job.status === 'running') return false;
      job.markCancelled(clock());
      await _persist(job);
      if (metrics) metrics.recordCancelled();
      _recordLifecycle('cancelled', namespace, id);
      _emit(JOB_EVENTS.CANCELLED, { jobId: id, namespace, type: job.type });
      return true;
    });
  }

  // ── §1 status ──────────────────────────────────────────────────────────────────
  function status(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const id = typeof spec === 'string' ? spec : spec.jobId;
    return (async () => {
      const model = await _safe(() => provider.getJob(namespace, id));
      return model || null;
    })();
  }

  // ── §1/§9 verify (job integrity across a namespace) ────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      const ids = _statusIndex.get(namespace) || new Map();
      for (const id of ids.keys()) {
        const model = await _safe(() => provider.getJob(namespace, id));
        if (!model) {
          issues.push({ jobId: id, reason: 'missing in provider' });
          continue;
        }
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ jobId: id, reason: 'checksum mismatch' });
        }
      }
      return { ok: issues.length === 0, issues };
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    return {
      ok: Boolean(providerHealth && providerHealth.ok),
      provider: providerHealth,
      handlers: _handlers.size,
      jobs: _countAll(),
      running: _countStatus((s) => s === 'running'),
      deadLetter: _countStatus((s) => s === 'dead_letter'),
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listJobs(namespace));
      return models.map((m) => fromModel(m, { clock }).toPublic());
    })();
  }
  function deadLetters(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const models = await _safe(() => provider.listJobs(namespace));
      return models.filter((m) => m.status === 'dead_letter');
    })();
  }
  async function snapshotJob(namespace, id) {
    const m = await _safe(() => provider.getJob(namespace, id));
    return m ? _deepFreeze(fromModel(m, { clock }).toPublic()) : null;
  }
  function diagnostics(namespace = 'default') {
    return {
      handlers: _handlers.size,
      jobs: (_statusIndex.get(namespace) || new Map()).size,
      totalJobs: _countAll(),
      running: _countStatus((s) => s === 'running'),
      deadLetter: _countStatus((s) => s === 'dead_letter'),
      namespaces: _statusIndex.size,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }
  const history = () => _lifecycle.map((h) => ({ ...h }));

  return {
    register,
    enqueue,
    schedule,
    cancel,
    status,
    verify,
    health,
    // additive helpers
    tick,
    list,
    deadLetters,
    snapshotJob,
    diagnostics,
    history,
    STATUS,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createJobsService };
