# Enterprise Workflow Engine — Developer Guide (ADR-023)

The Workflow Engine is the first **integrated** kernel component: it coordinates Storage, Lock,
Scheduler, the Event Backbone, and Configuration so a business process is expressed as one
declarative state machine instead of logic scattered across services. The engine holds **no
business logic** — behavior lives in the definition you supply.

## 1. Compose (wire the kernels)

```js
const { createStoragePlatform } = require('../../src/application/storage');
const { createLockPlatform } = require('../../src/application/lock');
const { createSchedulerPlatform } = require('../../src/application/scheduler');
const { createWorkflowPlatform } = require('../../src/application/workflow');

const st = createStoragePlatform({ publisher });
const lk = createLockPlatform({ publisher });
const sc = createSchedulerPlatform({ publisher });

const wf = createWorkflowPlatform({
  storage: st.storage, // required — persists workflow state
  lock: lk.lock, // optional — guards concurrent modification
  scheduler: sc.scheduler, // optional — per-state timeouts
  config, // optional — engine policies
  publisher, // Event Backbone — transition events
});
const engine = wf.engine;
```

In production the Scheduler is driven by `sc.scheduler.start()`; in tests advance it with
`sc.scheduler.tick(now)`.

## 2. Define a workflow (declarative)

```js
engine.register({
  name: 'trip',
  initial: 'requested',
  states: {
    requested: { onTimeout: { afterMs: 60000, to: 'expired' } },
    accepted: {},
    completed: { terminal: true },
    expired: { terminal: true, failure: true },
  },
  transitions: [
    {
      from: 'requested',
      on: 'accept',
      to: 'accepted',
      guard: (ctx, payload) => Boolean(ctx.rider), // may return a Promise
      action: (ctx, payload) => ({ driver: payload.driver }), // returns a context patch
    },
    { from: 'accepted', on: 'finish', to: 'completed' },
  ],
});
```

- **states** — `terminal` ends the workflow; `failure` marks a terminal state as a failure;
  `onTimeout: { afterMs, to }` arms a Scheduler timer that transitions if the state lingers.
- **transitions** — `(from, on) → to` with an optional `guard` (veto) and `action` (context
  patch). Guards/actions are functions kept on the definition, never persisted.

## 3. Run it

```js
const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
await engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd9' } });
await engine.signal({ workflowId: w.workflowId, event: 'finish' });

await engine.get(w.workflowId); // persisted instance model | null
await engine.list({ definitionName: 'trip', status: 'completed' });
await engine.cancel(w.workflowId);
await engine.health(); // wiring + metrics
```

`signal` throws `TransitionError` if no transition exists for `(state, event)`,
`GuardRejectedError` if a guard vetoes, and `InvalidStateError` if the workflow is not running.

## 4. What each kernel does here

| Kernel        | Role in the engine                                                     |
| ------------- | ---------------------------------------------------------------------- |
| Storage       | Persists every instance (`namespace: workflow`); rehydrated on demand. |
| Lock          | Guards a workflow against concurrent modification during a transition. |
| Scheduler     | Arms per-state timeouts; a real transition cancels the pending timer.  |
| Event Backbone| Publishes `Workflow*` lifecycle events through the EventPublisher port.|
| Configuration | Supplies engine policies (e.g. `workflow.lockLeaseMs`).                |

Concurrent `signal` calls on one workflow are serialized (in-process + Lock), so exactly one
transition applies and no state interleaving occurs.

## 5. Events

`WorkflowStarted`, `WorkflowTransitioned`, `WorkflowCompleted`, `WorkflowFailed`,
`WorkflowCancelled`, `WorkflowSuspended`, `WorkflowResumed`, `WorkflowTimedOut` — all via the
Event Backbone, producer `workflow`.

## 6. Observability

```js
wf.metrics.snapshot(); // started/completed/failed/cancelled, transitions, timeouts, active, latency
wf.metrics.prometheus();
```

## 7. SDK integration (ADR-018)

```js
const { toWorkflowPort } = require('../../src/application/workflow/sdkAdapter');

const portFactories = {
  'workflow:read': () => toWorkflowPort(engine, { owner: extId, canWrite: false }),
  'workflow:write': () => toWorkflowPort(engine, { owner: extId }),
};
// Inside the extension: this.workflow().start({ definitionName: 'my-flow', input })
```

Definition names are prefixed with the extension id and workflows are tagged with the owner, so
an extension can only see and drive its own workflows. Write ops require `workflow:write`, reads
require `workflow:read`.

## 6a. Production hardening (added in the completion pass)

```js
await engine.snapshot(workflowId); // deep-frozen, immutable instance model
engine.verifyStartup(); // { ok, problems } — call before trusting the engine
await engine.verifyWorkflow(workflowId); // integrity: declared state + contiguous history
await engine.recover(); // re-arm timeouts after a restart; report corrupt records
engine.diagnostics(); // wiring, active timers/chains, startup, metrics
engine.history(); // bounded engine lifecycle log
```

Transition history is bounded by `historyLimit` (default 1000). Corrupt persisted records are
rejected on load. New metrics: transition latency, workflow duration, scheduler
reconciliations, lock conflicts, storage failures, event-publication failures. Extra optional
deps: `historyLimit`, `engineHistoryLimit`.

## Out of scope (future work behind the same ports)

Durable timers across process restarts, sub-workflows, and human-task / wait-for-signal
correlation.
