# Enterprise Scheduler — Developer Guide (Phase 14.3.3)

The Scheduler is a Kernel Service: every Platform Service and Extension schedules work through
its Port. It is in-process, deterministic, and observable — not a cron wrapper and not an
application scheduler.

## 1. Compose

```js
const { createSchedulerPlatform } = require('../../src/application/scheduler');

const sched = createSchedulerPlatform({
  concurrency: 8, // worker-pool limit
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const s = sched.scheduler;
```

In production, drive ticks with `s.start(1000)` (ticks each second) and `s.stop()` to halt.
In tests, advance time yourself: `await s.tick(nowMs)`.

## 2. A job

```js
const job = {
  name: 'cleanup', // required
  owner: 'fleet-service', // required
  handler: async (ctx) => {
    /* ctx = { jobId, attempt, metadata, signal, logger } */
  },
  priority: 'high', // low | normal | high | critical
  timeout: 5000, // ms; 0 = no timeout
  retryPolicy: { type: 'exponential', maxAttempts: 3, delayMs: 200, factor: 2, maxDelayMs: 5000 },
  metadata: { region: 'us' },
  tags: ['maintenance'],
};
```

## 3. Scheduling API

```js
s.schedule(job); // uses the job's own timing (immediate / interval / cron if set)
s.scheduleAt(job, date); // one-time at an absolute Date or ms epoch
s.scheduleAfter(job, 60000); // one-time after a delay
s.scheduleRecurring(job, '0 3 * * *'); // cron string …
s.scheduleRecurring(job, { intervalMs: 30000 }); // … or a fixed interval
```

Control: `s.cancel(id)`, `s.pause(id)`, `s.resume(id)`, `s.runNow(id)`. Introspect:
`s.exists(id)`, `s.list()`, `s.status(id)`, `s.deadLetter()`.

## 4. Retry + dead letter

On failure the retry policy decides: `none` never retries; `fixed` waits a constant delay;
`exponential` grows `delayMs * factor^retries` (clamped by `maxDelayMs`). After `maxAttempts`
retries the job is **dead-lettered** (`s.deadLetter()`) and a `JobFailed` event is published.

## 5. Timeout + cancellation + isolation

A job exceeding `timeout` is aborted (its `ctx.signal` fires), marked timed-out, and then
follows its retry policy. A handler that throws or hangs never affects sibling jobs — each
execution is isolated. `cancel()` aborts an in-flight job and prevents reruns.

## 6. Events (through the port only)

`JobScheduled`, `JobStarted`, `JobCompleted`, `JobFailed`, `JobCancelled`, `JobTimedOut`,
`JobRetried`, `JobPaused`, `JobResumed` — all via the EventPublisher port, producer
`scheduler`. The EventBus is never exposed.

## 7. Observability

```js
sched.metrics.snapshot(); // scheduled/running/completed/failed, retries, durations,
// queue depth, worker utilization
sched.metrics.prometheus(); // Prometheus exposition text
```

## 8. Graceful shutdown

`await s.shutdown()` stops the driver, admits no new work, and waits for in-flight jobs to
settle.

## 9. SDK integration (ADR-018)

Grant an extension an owner-scoped scheduler through a port — no internals leak:

```js
const { toSchedulerPort } = require('../../src/application/scheduler/sdkAdapter');

const portFactories = {
  'schedule:jobs': () => toSchedulerPort(sched.scheduler, { owner: extensionId }),
};
// Inside the extension, e.g. exposed as this.scheduler():
//   this.scheduler().scheduleAfter({ name, handler }, 1000)
```

The extension can only see and control its **own** jobs, and scheduling requires the
`schedule:jobs` capability to be granted (otherwise the call throws a `PermissionError`).

## 8a. Production hardening (added in the completion pass)

Overlapping ticks are serialized (no double-draining); a backwards clock is detected and
reported (`diagnostics().clockRegressions`) but never fatal; `shutdown({ maxWaitMs })` drains
in-flight work but is bounded so it can't hang. Additional operator surfaces:

```js
s.recover({ maxRunningMs: 60000 }); // re-queue jobs stuck RUNNING after a crash
s.jobSnapshot(jobId); // deep-frozen, immutable job model
s.history(); // bounded lifecycle-transition log
s.verifyQueue(); // { ok, runningCounter, runningJobs, concurrency }
s.verifyStartup(); // { ok, problems }  — call before trusting the scheduler
s.diagnostics(); // structured health for dashboards
s.health(); // { status: 'healthy' | 'degraded', ... }
s.uptime(); // ms since construction
```

New metrics: `scheduler_queue_latency_ms_avg/last`, `scheduler_dead_letter_size`,
`scheduler_uptime_ms`, `scheduler_jobs_queued`. Extra optional dep: `historyLimit`.

## Out of scope (by mandate)

No distributed scheduling, no external queues, no cross-restart persistence, and no business
workflows — those are future concerns behind this port.
