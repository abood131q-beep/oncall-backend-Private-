# Phase 17.4 — Observability Adapter Specification

`src/platform-adapters/observability/index.js` — the single, sanctioned boundary between the
OnCall application and the Observability Kernel (ADR-033).

---

## 1. Contract

`createObservabilityAdapter({ port, componentPrefix })` returns a frozen object:

| Member | Kind | Maps to kernel | Notes |
|---|---|---|---|
| `name` | value | — | `'observability'` |
| `kernel` | value | — | `'observability (ADR-033)'` |
| `consumed()` | pure | — | `true` iff a port is injected |
| `toKernelSpec(obs, service)` | pure translator | — | legacy observation → `{service, health, counters, gauges, timers, metadata}` |
| `fromKernelModel(model)` | pure translator | — | kernel component model → legacy observation shape |
| `record(obs)` | active write | `register` + `collect` | registers a FRESH component, collects the encoded report; returns its id |
| `readComponent(id)` | active read | `snapshot` | finds the component and decodes it |
| `health()` | pure | — | `{ ok:true, consumed }` |

## 2. Encoding codec (deterministic, lossless)

| Legacy field | Kernel storage | Encode | Decode |
|---|---|---|---|
| `health.status` | health enum | `ok→healthy`, `degraded→degraded`, `unhealthy→failed` | inverse |
| `health.checks.<n>` | gauge `check.<n>` | `ok→0`, `warning→1`, `error→2` | inverse |
| `readiness.ready` | gauge `readiness.ready` | `true→1/false→0` | `===1` |
| `liveness.live` | gauge `liveness.live` | `true→1/false→0` | `===1` |
| `counters.*` | counters (ADD) | pass-through (fresh component) | pass-through |
| `gauges.*` | gauges (SET) | pass-through | pass-through |
| `timers.*` | timers `{count,totalMs,lastMs}` | pass-through | `lastMs` |
| `health.tags`, `event`, `log` | component `metadata` | pass-through | pass-through |

`encode ∘ decode = identity` for every field family ⇒ exact round-trip.

## 3. Rules

1. **Translation only** — no business logic; no repository/DB/service access (asserted by the
   adapter-layer test that forbids `repo|db|database` surfaces).
2. **Kernel-only through the port** — active methods call `requirePort('observability', port)`
   and reject with `AdapterNotWiredError` when inert.
3. **Read-only / non-authoritative** — `record()` writes only a shadow copy into the kernel;
   the decoded read-back is consumed only by the shadow verifier and never returned to the app.
4. **Fresh component per pass** — each `record()` uses a new `componentId` so counters (which
   ADD in the kernel) never accumulate across passes.

## 4. Injection

Injected exclusively by `src/enterprise/index.js` via
`createPlatformAdapters({ ports: { observability: runtime.platform().getKernel('observability') } })`,
and only when `PLATFORM_OBSERVABILITY=1`.

## 5. Inert vs consumed

| State | Condition | Behavior |
|---|---|---|
| Inert (default) | no port | `consumed()===false`; active methods reject with `AdapterNotWiredError` |
| Consumed (shadow) | port injected | `consumed()===true`; `record`/`readComponent` delegate to the kernel; still non-authoritative |

## 6. Test coverage
`tests/unit/observability-shadow.test.js`: inert guard; `toKernelSpec`/`fromKernelModel` lossless
round-trip of a full observation; adapter-backed shadow reaching 100% parity.
