# ADR-032 — Enterprise Background Jobs Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.3 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-021 (Storage), ADR-023 (Workflow),
ADR-024 (Messaging), ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-028
(Secrets)

## Context

The platform needs one deterministic way to run asynchronous work: enqueue jobs, execute
them with retries and backoff, detect timeouts, recover from failures, dead-letter the
unrecoverable, deduplicate, and stay idempotent — independent of any queue product. This
is the Background Jobs Kernel. It is **not BullMQ / RabbitMQ / Sidekiq / Hangfire** — those
are provider/persistence details, not dependencies.

Background-job logic must never be embedded in individual services (each rolling its own
retry loop and queue). Instead it is a Kernel Service behind a narrow port, so every
service enqueues the same way and execution is handled in exactly one place.

To stay strictly additive, the kernel lives under `jobs/` (new directories); no existing
kernel or application bounded context is touched.

## Decision

Add an additive Background Jobs Kernel. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not it is instantiated.

**Domain (pure):**

- `job.js` — the Job value object (jobId, namespace, type, handler, payload, priority,
  status, retryPolicy, attemptCount, maxAttempts, scheduledTime, startedTime,
  completedTime, failedTime, timeout, correlationId, workflowId, metadata, dedupKey,
  idempotencyKey, nextAttemptAt, lastError, deadLettered, history, seq, version,
  `checksum`). A canonical content checksum gives integrity; status transitions
  (queued/scheduled/running/completed/retrying/dead_letter/cancelled) are deterministic and
  append to an execution history.
- `retryPolicy.js` — a frozen value object (maxAttempts, backoffMs, factor, maxBackoffMs)
  with deterministic `shouldRetry` + `nextDelayMs`.
- `errors.js` — `JobError`, `JobValidationError`, `JobNotFoundError`, `HandlerError`,
  `IntegrityError`.
- `events.js` — the job event catalog (JobRegistered, JobQueued, JobStarted, JobCompleted,
  JobFailed, JobRetried, JobCancelled); producer `jobs`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putJob / getJob / listJobs / removeJob /
  health) + declared extension points (Redis, PostgreSQL, Storage, MongoDB, message queue,
  custom). Providers persist jobs; the engine owns all execution.
- `providers/memoryProvider.js` — the implemented in-process job store.
- `metrics.js` — registered types (gauge), queued / running / dead-letter (gauges),
  completed / failed / retried (counters), execution latency, provider failures, uptime;
  Prometheus.
- `jobsPort.js` — the abstraction contract (`assertJobs`): register, enqueue, schedule,
  cancel, status, verify, health.
- `jobsService.js` — the kernel: a handler registry, deterministic queue ordering (priority
  then FIFO by seq), priority scheduling, retry with backoff, timeout detection + failure
  recovery, cancellation, a dead-letter queue, duplicate detection, idempotency, execution
  history, and verification. Tick-driven (`tick(now)`) with an injected clock — no
  wall-clock timers. Per-job mutations are atomic via a serialization mutex.
- `sdkAdapter.js` — `toJobsPort(jobs, { owner, canEnqueue, canRead })`: namespace isolation
  + `jobs:enqueue` / `jobs:read` enforcement (no handler registration).
- `index.js` — `createJobsPlatform(deps)` composition root.

## Kernel integration

Per §5, the Background Jobs Kernel integrates with other kernels **only through their
existing ports** — the Event Backbone (EventPublisher) for lifecycle events; the Scheduler
(ADR-020) drives `tick()`; Workflow (ADR-023) correlates via `workflowId`; Messaging
(ADR-024) can fan work out; the authorization context from Identity (ADR-027) and Policy
(ADR-025) governs `jobs:enqueue`/`jobs:read`; Audit (ADR-026) records events; Storage
(ADR-021) is the model behind a future durable provider; Configuration (ADR-019) and
Secrets (ADR-028) supply job config + credentials. It imports no implementation classes.

## Alternatives rejected

- **BullMQ / RabbitMQ / Sidekiq / Hangfire as a dependency** — rejected: couples the
  platform to an external job product. Redis/Postgres/Storage/Mongo/MQ remain provider
  extension points.
- **Wall-clock timers for scheduling/retry** — rejected: the engine is tick-driven with an
  injected clock, so ordering, backoff, and timeout detection are fully deterministic.
- **Embedding job logic in each service** — rejected: duplicates retry/queue logic and
  defeats uniform execution + audit.
- **Provider-side execution** — rejected: queueing, retry, timeout, dead-letter, dedup, and
  idempotency live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/jobs/**` and `src/application/jobs/**`, plus
  `tests/unit/jobs.test.js` (+19 tests). Zero hot-path change; A/B byte-identical.
- Real durable stores (Redis/Postgres/Storage/Mongo/MQ), multi-worker distribution, and
  visibility-timeout leasing are future work behind the provider port. The memory provider
  is single-process (the per-job mutex + tick model prevent double execution in-process).

## Rollback

Delete `src/domain/jobs/`, `src/application/jobs/`, and `tests/unit/jobs.test.js`. Nothing
imports them at runtime, so removal is inert and every prior kernel (ADR-016 … ADR-031) is
unchanged. See `docs/JOBS-ROLLBACK-PLAN.md` for the full procedure.
