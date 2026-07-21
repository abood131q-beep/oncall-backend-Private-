# Phase 17.5 — Jobs Adapter Specification

`src/platform-adapters/jobs/index.js` — the single, sanctioned boundary between the OnCall
application and the Background Jobs Kernel (ADR-032). Governed by G1.0 §2.

---

## 1. Contract

`createJobsAdapter({ port, namespacePrefix })` returns a frozen object:

| Member | Kind | Maps to kernel | Notes |
|---|---|---|---|
| `name` | value | — | `'jobs'` |
| `kernel` | value | — | `'jobs (ADR-032)'` |
| `consumed()` | pure | — | `true` iff a port is injected |
| `toKernelSpec(descriptor)` | pure translator | — | descriptor → `{ type, kind, delayMs, payload }` |
| `fromKernelModel(model)` | pure translator | — | job model → `{ descriptor, kernel:{type,status} }` |
| `expectedStatus(kind)` | pure | — | `interval→'scheduled'`, `startup→'queued'` |
| `nextNamespace()` | pure | — | fresh per-pass namespace (isolation) |
| `record(descriptor, ns?)` | active write | `register` + `schedule`/`enqueue` | places a definition; **never ticks**; returns `{jobId, namespace}` |
| `readJob(id, ns)` | active read | `status` | reads a placed job back, decoded |
| `health()` | pure | — | `{ ok:true, consumed }` |

## 2. Non-execution guarantee (ADR-032)

`record()` performs exactly: `register({ type, handler: NOOP })` then
`schedule(...)` (interval) or `enqueue(...)` (startup). It **never** calls `tick()`, and the
platform never auto-ticks — so the no-op handler is never invoked and **no job executes**.
Placed jobs sit in `scheduled` / `queued` state; they never reach `running` or `completed`.
Verified by test (`kernel._ticked() === false`, health `running === 0`).

## 3. Rules (G1.0 §2)

1. **Translation only** — no business logic; no repository/DB/service access (adapter-layer
   guard test forbids `repo|db|sqlite|database` member names).
2. **Kernel-only through the port** — active methods call `requirePort('jobs', port)` and
   reject with `AdapterNotWiredError` when inert (async ⇒ they reject rather than sync-throw).
3. **Read-only / non-authoritative** — the decoded read-back is consumed only by the shadow
   verifier and never returned to the application.
4. **Stateless / deterministic** — the only internal state is a monotonic namespace counter for
   per-pass isolation (not observable behavior).
5. **Fresh namespace per pass** — prevents cross-pass accumulation in the kernel.

## 4. Encoding

| Legacy descriptor | Kernel representation |
|---|---|
| `id` | job `type` (identity) |
| `kind` (`interval`/`startup`) | `schedule` (→ `scheduled`) / `enqueue` (→ `queued`) |
| `intervalMs` | `delayMs` on `schedule` + carried in `payload` |
| `idempotent`, `owner`, `enabled`, `intervalMs`, `kind`, `id` | carried losslessly in `payload` |

Decode reconstructs `{ descriptor: model.payload, kernel: { type, status } }`.

## 5. Injection

Injected exclusively by `src/enterprise/index.js` via
`createPlatformAdapters({ ports: { jobs: runtime.platform().getKernel('jobs') } })`, and only
when `PLATFORM_JOBS=1`.

## 6. Inert vs consumed

| State | Condition | Behavior |
|---|---|---|
| Inert (default) | no port | `consumed()===false`; active methods reject with `AdapterNotWiredError` |
| Consumed (shadow) | port injected | `consumed()===true`; `record`/`readJob` delegate to the kernel; non-authoritative, non-executing |
