# ADR-020 — Enterprise Scheduler

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.3.3 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration Platform)

## Context

Platform Services and Extensions need to run work later, on a delay, on an interval, or on a
cron schedule — with retries, timeouts, cancellation, and observability. This is a Kernel
Service, not a cron wrapper and not an application scheduler: it must be additive, in-process
(no distributed scheduling, no external queues), deterministic, and reachable only through a
Port.

## Decision

Add a self-contained, additive Scheduler. Nothing in it is imported by a hot path, so the
platform runs byte-identically whether or not the scheduler is instantiated.

**Domain (pure):**

- `job.js` — the Job aggregate (identity = jobId) with the required model fields and its own
  status transitions (scheduled/running/completed/failed/timed_out/cancelled/paused/retrying);
  priority levels; schedule types (once/delayed/interval/cron).
- `retryPolicy.js` — none / fixed / exponential-backoff with a max-attempts cap; `decide()`
  returns retry-or-dead-letter + delay. Deterministic.
- `cron.js` — dependency-free 5-field cron parser + `nextAfter()` (UTC, deterministic).
- `schedule.js` — computes the next run instant per schedule type and recurrence.
- `events.js` — self-contained scheduler event catalog (JobScheduled/Started/Completed/
  Failed/Cancelled/TimedOut/Retried/Paused/Resumed); builds canonical DomainEvents
  (producer `scheduler`).

**Application (ports & adapters):**

- `schedulerPort.js` — the abstraction contract (`assertScheduler`).
- `metrics.js` — jobs scheduled/running/completed/failed, retries, execution duration, queue
  depth, worker utilization; Prometheus exposition.
- `scheduler.js` — the engine: priority-ordered ready set, concurrency-limited worker pool,
  per-job timeout + AbortController cancellation, execution isolation, retry + dead-letter,
  and graceful shutdown. Time is injected (`clock()`) and work advanced by `tick(now)` for
  determinism; `start(intervalMs)` drives ticks in production.
- `sdkAdapter.js` — `toSchedulerPort(scheduler, { owner, canSchedule })`: an owner-scoped,
  capability-gated facade (ADR-018 integration) that leaks no engine internals.
- `index.js` — `createSchedulerPlatform(deps)` composition root.

## Alternatives rejected

- **A cron library / external queue (Bull/Agenda/Redis)** — rejected: violates the additive,
  dependency-free, in-process mandate; distributed scheduling is explicitly out of scope.
- **Wall-clock timer at the core** — rejected: non-deterministic and hard to test. The core is
  tick-driven; the interval timer is only a thin production driver.
- **Exposing the engine to extensions directly** — rejected: breaks isolation/ownership.
  Extensions get only the owner-scoped port.

## Consequences

- New files under `src/domain/scheduler/**` and `src/application/scheduler/**`, plus
  `tests/unit/scheduler.test.js` (+16 tests). Zero hot-path change; A/B byte-identical.
- Distributed scheduling, persistence across restarts, and business workflows are explicitly
  out of scope (future work behind this port).

## Rollback

Delete `src/domain/scheduler/`, `src/application/scheduler/`, and `tests/unit/scheduler.test.js`.
Nothing imports them at runtime, so removal is inert and the platform is unchanged.
