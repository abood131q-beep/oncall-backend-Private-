# ADR-023 — Enterprise Workflow Engine

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.4 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-021 (Storage), ADR-022 (Lock)

## Context

The kernel services (Event Backbone, Extension Platform + SDK, Configuration, Scheduler,
Storage, Lock) are complete but standalone. Business processes — a ride request, a scooter
rental, a payment capture — are currently expressed as distributed, ad-hoc logic inside
services. The Workflow Engine is the **first integrated kernel component**: it coordinates the
existing kernels so processes can be defined as unified, declarative state machines instead of
scattered code. Completing it turns a set of separate kernel services into an integrated
**Kernel Platform**.

## Decision

Add an additive Workflow Engine that orchestrates the kernels **through their Ports only**,
never their internals, and contains **no business logic** (behavior lives in declarative
definitions). Nothing here is on a hot path, so the platform runs byte-identically whether or
not the engine is instantiated.

**Domain (pure):**

- `definition.js` — a declarative state machine: states (with `terminal`/`failure`/`onTimeout`),
  event-driven transitions with optional `guard`/`action`, validated on construction.
- `instance.js` — the running-process aggregate (identity `workflowId`): state, status
  (`running/completed/failed/cancelled/suspended`), `context`, monotonic `version`, and
  transition `history`; deterministic transitions; `toModel`/`fromModel` for persistence.
- `errors.js` — `WorkflowError`, `DefinitionError`, `TransitionError`, `GuardRejectedError`,
  `InvalidStateError`, `WorkflowNotFoundError`.
- `events.js` — the workflow event catalog (Started/Transitioned/Completed/Failed/Cancelled/
  Suspended/Resumed/TimedOut); producer `workflow`.

**Application (integration):**

- `workflowService.js` — the engine. Orchestration via injected ports:
  - **Storage (ADR-021)** persists each instance (`namespace: workflow`, one collection).
  - **Lock (ADR-022)** guards each workflow against concurrent modification; the engine also
    serializes per-workflow operations in-process so transitions never interleave.
  - **Scheduler (ADR-020)** arms a per-state timeout job; a real transition cancels it, and a
    fired timer applies the state's timeout transition (guarded against stale fires by
    checking state + version).
  - **Event Backbone (ADR-016)** publishes every lifecycle event through the EventPublisher port.
  - **Configuration (ADR-019)** supplies engine policies (e.g. lock lease).
- `metrics.js` — started/completed/failed/cancelled, transitions, timeouts, active gauge,
  latency; Prometheus.
- `sdkAdapter.js` — `toWorkflowPort(engine, { owner, canRead, canWrite })`: ownership
  isolation, owner-prefixed definition names, and `workflow:read`/`workflow:write` capability
  enforcement (ADR-018 integration).
- `index.js` — `createWorkflowPlatform(deps)` composition root.

## Alternatives rejected

- **A BPMN engine / external workflow product** — rejected: heavy, couples to a runtime, and
  duplicates capabilities the kernels already provide. The engine reuses Storage/Lock/
  Scheduler/Events instead.
- **Embedding process logic in services** — rejected: that is exactly the distributed logic
  this ADR replaces with unified definitions.
- **Business logic in the engine** — rejected: the engine is a generic interpreter; guards and
  actions live in the definition supplied by the caller.

## Consequences

- New files under `src/domain/workflow/**` and `src/application/workflow/**`, plus
  `tests/unit/workflow.test.js` (+11 tests). Zero hot-path change; A/B byte-identical.
- OnCall can now express trips, rentals, payments, and other processes as workflow definitions
  over the shared kernel platform.
- Durable timers across restarts, sub-workflows, and human-task/wait-for-signal correlation
  are future work behind the same ports.

## Rollback

Delete `src/domain/workflow/`, `src/application/workflow/`, and `tests/unit/workflow.test.js`.
Nothing imports them at runtime, so removal is inert and every prior kernel is unchanged.

## Amendment A-001 — Production hardening (2026-07-20)

A hardening pass added the following **additively** — no public API signature changed, no
module was rewritten, and behavior for existing callers is unchanged:

- **Immutable snapshots** — `snapshot(workflowId)` returns a deep-frozen instance model.
- **Transition-history ring buffer** — instance history is bounded by `historyLimit`
  (default 1000) so a long-running/looping workflow can't grow memory without bound.
- **Corruption detection** — a structurally invalid persisted record (missing
  state/status/version/definition) is rejected on load rather than silently trusted.
- **Startup + integrity verification** — `verifyStartup()` checks wiring; `verifyWorkflow(id)`
  checks the state is declared and the history chain is contiguous and matches the current state.
- **Workflow recovery + scheduler reconciliation** — `recover()` re-arms per-state timeout
  timers for every running workflow after a restart (in-memory timers don't survive) and
  reports corrupt records without throwing.
- **Engine lifecycle history** — a bounded ring buffer via `history()`.
- **Structured diagnostics** — `diagnostics()` (wiring, timers, chains, startup, metrics).
- **Expanded metrics** — transition latency, workflow duration, scheduler reconciliations,
  lock conflicts, storage failures, event-publication failures (with Prometheus lines).

New optional deps: `historyLimit`, `engineHistoryLimit`. Tests:
`tests/unit/workflow-hardening.test.js`.
