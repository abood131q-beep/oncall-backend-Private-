# Phase 17.6 — Scheduler Adapter Specification

`src/platform-adapters/scheduler/index.js` — the single, sanctioned boundary between the OnCall
application and the Scheduler Kernel (ADR-020). Governed by G1.0 §2.

---

## 1. Contract

`createSchedulerAdapter({ port })` returns a frozen object:

| Member | Kind | Maps to kernel | Notes |
|---|---|---|---|
| `name` | value | — | `'scheduler'` |
| `kernel` | value | — | `'scheduler (ADR-020)'` |
| `consumed()` | pure | — | `true` iff a port is injected |
| `toKernelSpec(descriptor)` | pure translator | — | descriptor → `{ name, owner, kind, intervalMs, metadata }` |
| `fromKernelModel(model)` | pure translator | — | job model → `{ descriptor, kernel:{name,owner,scheduleType,status} }` |
| `expectedScheduleType(kind)` | pure | — | `interval→'interval'`, `startup→'once'` |
| `record(descriptor)` | active write | `scheduleRecurring`/`scheduleAt` | registers a schedule; **never start()/tick()**; returns `{jobId}` |
| `readRef(ref)` | active read | `jobSnapshot` | reads a placed schedule back, decoded |
| `health()` | pure | — | `{ ok:true, consumed }` |

The generic round-trip verifier requires exactly `record(item)→ref` + `readRef(ref)→view`;
this adapter satisfies that uniform contract (shared with the Jobs adapter).

## 2. Non-ownership / non-execution guarantee (ADR-020)

`record()` calls only `scheduleRecurring` (interval) or `scheduleAt` (startup/once) with a
**no-op handler**. It **never** calls `start()` (which would arm a real `setInterval`) or
`tick()` (which would execute). The platform never auto-starts the scheduler. So no timer is
owned and nothing runs; placed schedules stay `scheduled`. Verified by test
(`kernel._started() === false`, `kernel._ticked() === false`, all statuses `scheduled`,
`health().running === 0`).

## 3. Rules (G1.0 §2)

1. **Translation only** — no business logic; no repository/DB/service access (adapter-layer
   guard forbids `repo|db|sqlite|database` member names — hence `readRef`, not `readBack`).
2. **Kernel-only through the port** — active methods call `requirePort('scheduler', port)` and
   reject with `AdapterNotWiredError` when inert (async ⇒ reject, not sync-throw).
3. **Read-only / non-authoritative** — the decoded read-back is consumed only by the shadow
   verifier and never returned to the application.
4. **Stateless / deterministic** — no mutable instance state.

## 4. Encoding

| Legacy descriptor | Kernel representation |
|---|---|
| `id` | job `name` (identity) |
| `owner` | job `owner` |
| `kind` (interval/startup) | `scheduleRecurring` (→ scheduleType `interval`) / `scheduleAt` (→ `once`) |
| `intervalMs` | recurring `{ intervalMs }` + carried in `metadata.payload` |
| `cron`, `enabled`, `id`, `owner`, `kind`, `intervalMs` | carried losslessly in `metadata.payload` |

Decode reconstructs `{ descriptor: metadata.payload, kernel: { name, owner, scheduleType, status } }`.

## 5. Injection

Injected exclusively by `src/enterprise/index.js` via
`createPlatformAdapters({ ports: { scheduler: runtime.platform().getKernel('scheduler') } })`,
and only when `PLATFORM_SCHEDULER=1`.

## 6. Inert vs consumed

| State | Condition | Behavior |
|---|---|---|
| Inert (default) | no port | `consumed()===false`; active methods reject with `AdapterNotWiredError` |
| Consumed (shadow) | port injected | `consumed()===true`; `record`/`readRef` delegate to the kernel; non-authoritative, non-executing |
