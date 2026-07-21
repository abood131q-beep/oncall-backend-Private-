# Enterprise Background Jobs Kernel — Provider Guide (ADR-032 §4)

A Jobs provider **persists job models only**. It never executes handlers, retries, times
out, dead-letters, deduplicates, or emits events — all of that lives in the engine, so
engine behavior is identical regardless of which provider is active. This is the seam a
future Redis / PostgreSQL / Storage / MongoDB / message-queue adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                          | Returns         | Notes                              |
| ------------------------------- | --------------- | ---------------------------------- |
| `name`                          | `string`        | Non-empty adapter name.            |
| `putJob(namespace, model)`      | `void`          | Upsert a job by `jobId`.           |
| `getJob(namespace, jobId)`      | `model \| null` | A job, or `null`.                  |
| `listJobs(namespace)`           | `model[]`       | All jobs in the namespace.         |
| `removeJob(namespace, jobId)`   | `boolean`       | `true` if removed.                 |
| `health()`                      | `{ ok, ... }`   | Liveness + counts.                 |

### Job model shape (opaque to the provider)

```jsonc
{
  "jobId": "job_...",
  "namespace": "default",
  "type": "send-email",
  "handler": "send-email",
  "payload": { "to": "a@b.c" },
  "priority": 5,
  "status": "queued",            // created|queued|scheduled|running|completed|retrying|dead_letter|cancelled
  "retryPolicy": { "maxAttempts": 3, "backoffMs": 1000, "factor": 2, "maxBackoffMs": 0 },
  "attemptCount": 0, "maxAttempts": 3,
  "scheduledTime": null, "startedTime": null, "completedTime": null, "failedTime": null,
  "timeout": 30000,
  "correlationId": "req-9", "workflowId": "wf-42",
  "metadata": {}, "dedupKey": null, "idempotencyKey": null,
  "nextAttemptAt": null, "lastError": null, "deadLettered": false,
  "history": [], "seq": 0,
  "createdAt": 0, "updatedAt": 0, "version": 1,
  "checksum": "<sha256 hex>"     // the engine owns it — round-trip verbatim
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the checksum, and never mutate the model. The engine derives
gauges and due-work from the job's `status`, `scheduledTime`, and `nextAttemptAt`.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `jobId → model`
  map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`redis`, `postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `mongodb`,
`message-queue`, `custom`.

```js
const { futureProvider } = require('../../src/application/jobs/providerPort');
const p = futureProvider('redis'); // { planned: true, ... }
p.putJob('ns', {}); // throws: "extension point — not implemented in Phase 15.3"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing job).
3. Keep it behavior-free — no execution/retry/timeout/dead-letter/events. The engine owns
   those.
4. For a multi-worker durable store, add a visibility-timeout / lease on `getJob` for
   `queued`/`retrying` work so two workers don't run the same job; the in-process engine
   already serializes per job, but cross-node leasing is the provider's responsibility.
5. Wire it in the composition root: `createJobsPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a job read back equals what was written (deep-copied), including
  `checksum`, `status`, `attemptCount`, and `history`.
- **Isolation** — namespaces never bleed into each other.
