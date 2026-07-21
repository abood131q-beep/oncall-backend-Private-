# Phase 17.1 — Risk Assessment (STEP 5)

Covers technical, migration, runtime, and performance risks, plus the rollback strategy.
Severity = Likelihood × Impact after the stated mitigation.

---

## 1. Technical Risks

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|---|---|---|---|---|---|
| T1 | **Kernels have no DB-backed providers** — a kernel that "owns" persistent state would silently use in-memory storage and lose data on restart | High (if attempted) | Critical | **High** | 17.1 forbids any kernel owning persistent state; owning is gated on blocker **B1**. Only wrap/observe postures allowed. |
| T2 | **Auth token drift** — Identity kernel issuing/verifying tokens with any structural difference breaks live Flutter sessions | Medium | Critical | **High** | Identity is observe-only in 17.1; token issue/verify stays in `middleware/auth.js`. A/B harness must prove byte-identical claims before any change (blocker **B2**). |
| T3 | **Route/response divergence** if Gateway is placed in the request path | Medium | High | **Medium** | Gateway kept out of the live path in 17.1 (observe/shadow only). |
| T4 | **Double execution of jobs** (kernel Scheduler + legacy `setInterval` both firing) → duplicate backups, double taxi auto-fix | Medium | Medium | **Medium** | Exactly-one-scheduler rule: kernel XOR legacy timers, enforced by `PLATFORM_JOBS` flag; idempotent job bodies. |
| T5 | **Socket.IO semantics change** (room names, event names, 120/min limit, live-fare math) | Low | High | **Medium** | `src/socket.js` runs unchanged inside the hosted service; Mesh/Messaging not in path. |
| T6 | **CommonJS/ESM & DI mismatch** — Platform composition assumes clean DI; app uses a monolithic `services` object | Low | Medium | **Low** | Adapters bridge the `services` object to kernel ports; no app DI rewrite. |
| T7 | **Migration ordering regression** — `server.listen` before migrations complete → "no such column" | Low | High | **Medium** | Hosted-service `start()` contract enforces migrations-before-listen via Lifecycle. |

---

## 2. Migration Risks

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|---|---|---|---|---|---|
| M1 | **Big-bang temptation** — integrating many kernels at once | Medium | High | **Medium** | Roadmap is small, independent, flag-guarded sub-phases; merge one at a time behind a default-OFF flag. |
| M2 | **Flag sprawl / forgotten flags** left in a half-cutover state | Medium | Medium | **Medium** | Each flag documented in `.env.example` with default + rollback meaning; CI asserts defaults reproduce baseline. |
| M3 | **Golden-output rot** — baseline snapshots drift from live behavior mid-migration | Low | Medium | **Low** | Re-capture goldens at each sub-phase entry; A/B harness is the merge gate. |
| M4 | **Provider parity gap** — future DB provider subtly differs from legacy SQL (FK, WAL, SQLITE_BUSY retry) | Medium | High | **Medium (deferred)** | Provider work is post-17.1; must pass the same A/B harness against the *existing* tables. |
| M5 | **Schema temptation** — a kernel wanting its own tables | Low | High | **Medium** | Hard rule: no schema change in 17.1; kernels read/write existing tables only. |

---

## 3. Runtime Risks

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|---|---|---|---|---|---|
| R1 | **Startup abort** — `verifyStartup()` fails and blocks boot when Platform enabled | Low | High | **Medium** | `PLATFORM_ENABLED` default OFF; verify() failures logged and fall back to standalone boot; verification already green in unit tests. |
| R2 | **Shutdown regression** — Lifecycle reverse-order stop conflicts with `io.close→server.close` sequencing | Low | High | **Medium** | Hosted-service `stop()` delegates to existing shutdown logic verbatim; 10 s force-timer preserved. |
| R3 | **Readiness gating false-negative** — Runtime marks not-ready while app is actually serving | Low | Medium | **Low** | `/health/ready` continues to reflect app truth; Runtime readiness is additive, not authoritative, in 17.1. |
| R4 | **Redis/multi-replica interaction** — Platform + existing Socket.IO Redis adapter both managing state | Low | Medium | **Low** | Existing Redis path unchanged; kernels do not touch Redis in 17.1. |
| R5 | **Process-guard conflict** — kernel supervisor vs existing `uncaughtException` exit | Low | Medium | **Low** | Keep app's process-level guards authoritative; kernel supervisor observes only. |

---

## 4. Performance Risks

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|---|---|---|---|---|---|
| P1 | **Startup latency** — composing 25 kernels adds boot time | Medium | Low | **Low** | One-time cost at boot; measured in 17.1.1; budget < +500 ms; kernels are memory-only (cheap). |
| P2 | **Steady-state memory** — 25 kernels + providers resident | Medium | Low | **Low** | Memory-only providers are small; measure delta in 17.1.1; alert if > agreed budget. |
| P3 | **Hot-path overhead** — shadow computation on auth/ratelimit per request | Medium | Medium | **Medium** | Shadows sampled (not 100%) and run off the critical path / async; disable via `SHADOW_*=0` instantly. |
| P4 | **Health aggregation cost** — `platform.health()` fanning out to all kernels on each probe | Low | Low | **Low** | Cache/throttle health sampling; existing endpoints keep their current cheap checks. |
| P5 | **GC pressure from bridges** — metrics/audit forwarding allocates | Low | Low | **Low** | Batch/forward asynchronously; measure in 17.1.4/17.1.6. |

---

## 5. Rollback Strategy

**Principle:** every sub-phase is a **flag flip away from the current production behavior**,
matching the repository's existing `*_LEGACY` convention. No rollback requires a code change,
a redeploy of different code, or a DB migration.

| Layer | Rollback action | Effect | Time to restore |
|---|---|---|---|
| Whole integration | `PLATFORM_ENABLED=0` | App boots as today's standalone `server.js` IIFE; Platform never instantiated | seconds (process restart) |
| Host/Lifecycle | `PLATFORM_HOST=0` | App uses statement-ordered boot; no hosted-service wrapper | seconds |
| Config mirror | `PLATFORM_CONFIG=0` | App reads `env.js` directly | seconds |
| Observability | `PLATFORM_OBS=0` | Endpoints render from legacy metrics source | seconds |
| Jobs/Scheduler | `PLATFORM_JOBS=0` | Legacy `setInterval` timers resume; kernel scheduler idle | seconds |
| Any shadow | `SHADOW_*=0` | That kernel stops shadowing; zero path impact regardless | seconds |
| Deployment | `PLATFORM_DEPLOY=0` | Use existing `deploy.sh` / `deploy-release.sh` | seconds |

**Rollback guarantees**
1. **Additivity:** with all flags at default (OFF for new coupling), the byte-for-byte
   behavior equals today's production — enforced by the A/B harness in CI (`npm run ci`).
2. **No data risk:** because no kernel owns persistent state in 17.1, rolling back never
   orphans or loses data.
3. **No client impact:** Flutter never observes routes, tokens, or Socket.IO changing, so
   rollback is invisible to clients.
4. **Fast detection:** shadow divergence dashboards + unchanged health endpoints surface any
   anomaly before it can affect a served request.

**Rollback runbook (per incident):** (1) identify the sub-phase flag from the deploy note →
(2) set flag to `0` → (3) rolling restart the hosted service (or `PLATFORM_ENABLED=0` for
full bail-out) → (4) confirm `/health/ready` + A/B golden → (5) file divergence report.
