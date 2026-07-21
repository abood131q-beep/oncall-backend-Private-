# Enterprise Background Jobs Kernel — Developer Guide (ADR-032)

The Background Jobs Kernel is the platform's unified abstraction for deterministic
asynchronous job execution, retries, scheduling, and failure recovery. It is **not
BullMQ/RabbitMQ/Sidekiq/Hangfire** — those are provider/persistence details. It lives under
`jobs/`, additive to every existing kernel.

## 1. Compose

```js
const { createJobsPlatform } = require('../../src/application/jobs');
const jk = createJobsPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const J = jk.jobs;
```

## 2. Register a handler for a job type

```js
J.register({
  type: 'send-email',
  handler: async (payload, ctx) => {
    // ctx: { jobId, namespace, attempt, metadata }
    await mailer.send(payload.to, payload.body);
  },
  maxAttempts: 3, // defaults applied to jobs of this type
  timeout: 30000,
  retryPolicy: { maxAttempts: 3, backoffMs: 1000, factor: 2 },
});
// → { type, registered: true }  (emits JobRegistered)
```

## 3. Enqueue + run

```js
const job = await J.enqueue({
  type: 'send-email',
  payload: { to: 'a@b.c', body: 'hi' },
  priority: 5, // higher runs first
  dedupKey: 'welcome:user-1', // optional duplicate suppression
  idempotencyKey: 'welcome:user-1', // optional: skip if already completed
  correlationId: 'req-9',
  workflowId: 'wf-42',
});
// job.status === 'queued'
await J.tick(now); // execute all due jobs; returns { processed, completed, failed, retried, deadLetter, timedOut }
```

The engine is **tick-driven** — it never sets wall-clock timers, so ordering, backoff, and
timeouts are deterministic. Drive `tick()` from the Scheduler kernel (ADR-020) or your own
loop.

## 4. Schedule for later

```js
await J.schedule({ type: 'send-email', payload: { ... }, delayMs: 60000 });
// or scheduledTime: <epoch ms>. Runs on the first tick at/after the due time.
```

## 5. Cancel + status

```js
await J.cancel({ jobId }); // → true (false if unknown / running / terminal)
await J.status({ jobId }); // → job model | null
```

## 6. Retries, timeouts & dead-letter

- **Retry** — a failed attempt reschedules with exponential backoff until `maxAttempts`;
  `tick()` retries when due (emits `JobFailed` + `JobRetried`).
- **Timeout** — a handler that runs past its `timeout` budget (or a job stuck `running`
  across ticks) is treated as a failed attempt (`lastError: 'timeout'`).
- **Dead-letter** — exhausted retries land in the dead-letter queue (`status:
  'dead_letter'`, `deadLettered: true`); inspect with `J.deadLetters({ namespace })`.

## 7. Deduplication & idempotency

- `dedupKey` collapses a repeat enqueue while a prior job with that key is still live
  (non-terminal); the existing job is returned.
- `idempotencyKey` short-circuits when a job with that key has already **completed**; the
  completed job is returned and the handler does not run again.

## 8. Events (through the port only)

`JobRegistered`, `JobQueued`, `JobStarted`, `JobCompleted`, `JobFailed`, `JobRetried`,
`JobCancelled` — all via the Event Backbone, producer `jobs`.

## 9. Observability

```js
jk.metrics.snapshot(); // registeredJobs, queuedJobs, runningJobs, deadLetterJobs,
// completed, failed, retried, execution latency, providerFailures, uptime
jk.metrics.prometheus();
await J.health();
```

## 10. SDK integration (ADR-018)

```js
const { toJobsPort } = require('../../src/application/jobs/sdkAdapter');
const portFactories = {
  'jobs:read': () => toJobsPort(jk.jobs, { owner: extId, canEnqueue: false }),
  'jobs:enqueue': () => toJobsPort(jk.jobs, { owner: extId }),
};
// Inside the extension: this.jobs().enqueue({ type, payload })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `enqueue`/`schedule`/
`cancel` require `jobs:enqueue`; `status`/`verify` require `jobs:read`. Handler registration
is administrative and not exposed to extensions.

## Determinism, ordering & integrity

- **Deterministic** — an injected clock drives scheduling, backoff, and timeouts; `tick()`
  runs due jobs in **priority-descending, then FIFO** order (by enqueue sequence).
- **Exactly-once per tick** — a per-job serialization mutex plus status guards ensure a job
  is not executed twice, even under concurrent ticks.
- **Integrity** — every job carries a checksum; `verify()` recomputes it across a namespace
  to detect tampering/corruption.

## Out of scope (future work behind the provider port)

Real durable stores (Redis/PostgreSQL/Storage/MongoDB/message queues), multi-worker
distribution, and visibility-timeout leasing are declared extension points, not implemented
in this phase. The memory provider is single-process.
