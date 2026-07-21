# Phase 17.5 — Jobs Integration Design

> **Governing standard:** G1.0 — Enterprise Shadow Integration Standard.
> **Authoritative documents (immutable):** ADR-032 (Jobs Kernel), G1.0, Phase 17 Completion
> Report. This document references them; it does not redefine them.

**Status:** Implemented. **Scope:** integrate the Enterprise Background Jobs Kernel (ADR-032)
through the existing Jobs Adapter, in **Shadow Mode only**, as the first integration performed
under the ratified G1.0 standard. The legacy scheduler remains the ONLY producer of work; the
Jobs Kernel is never authoritative and **never executes a job**.

---

## 1. Objective

Prove the Jobs Kernel can faithfully represent every legacy background job — its identity,
cadence, kind, idempotency, ownership, and lifecycle placement — by recording each job
*definition* into the kernel and comparing, **without** changing scheduling, timing, or
execution ownership, and **without ever running a job**.

## 2. Why Jobs is safe to shadow (ADR-032 property)

The Jobs Kernel is **tick-driven**: a job executes ONLY when `tick(now)` is called. Nothing
auto-executes on a wall clock. The shadow therefore places a job definition (via `register` +
`schedule`/`enqueue`) and **never calls `tick()`** — guaranteeing zero execution. This is the
structural basis for satisfying every "preserve …" and "never execute" constraint.

## 3. Shadow execution model (G1.0 §1)

```
Legacy Jobs (setInterval timers + startup cleanup)      ── SOURCE OF TRUTH / only producer
        │
        ▼
Jobs Adapter ─────────► Enterprise Jobs Kernel (ADR-032)   [register no-op handler + schedule; NEVER tick]
        │                        │
        │                        ▼
        │               kernel job model (scheduled/queued; never running) — never exposed
        ▼
Parity Verification (descriptor + native identity/status, field-by-field)
        ▼
Shadow Metrics (…/ parityPct / confidenceLevel / coveragePct)
        ▼
RETURN LEGACY BEHAVIOR   ── legacy scheduler unchanged
```

Implemented in `src/platform-adapters/jobs/shadow.js` (`verify()`).

## 4. Components (all additive)

| File | Role |
|---|---|
| `src/platform-adapters/_shadow/index.js` | **Shared shadow framework** (G1.0 §7): canonical `deepEqual`/`flatten` + full G1.0 §5 metrics incl. `confidenceLevel` **and** `coveragePct` + redaction. New go-forward reuse layer. |
| `src/platform-adapters/jobs/index.js` | Jobs Adapter — only kernel-facing surface; register no-op handler + schedule/enqueue; never ticks. |
| `src/platform-adapters/jobs/legacySource.js` | Read-only inventory of the 5 legacy background jobs (metadata only). |
| `src/platform-adapters/jobs/shadow.js` | Shadow verifier over the shared framework. |
| `src/enterprise/jobsShadow.js` | Flags + shadow attachment. |
| `src/enterprise/index.js` | Wires it behind `PLATFORM_JOBS` / `SHADOW_JOBS`. |

## 5. Legacy job inventory (unchanged; mirrors the real timers)

| Job id | Kind | Interval | Owner |
|---|---|---|---|
| `backup` | interval | 6 h | `src/services/backup.js` |
| `cache-sweep` | interval | 30 s | `src/services/cache.js` |
| `wal-checkpoint` | interval | 5 min | `src/app/onCallApplication.js` |
| `taxi-autofix` | interval | 1 h | `src/socket.js` |
| `ghost-trip-cleanup` | startup | one-shot | `src/app/onCallApplication.js` |

All are idempotent and `.unref()`ed; the shadow reads this inventory as metadata only.

## 6. How parity reaches 100% (lossless round-trip)

The full legacy descriptor rides on the kernel job **`payload`** (serializable ⇒ lossless), so
every descriptor field round-trips exactly. Additionally, the kernel-native `type` (job
identity) and `status` are verified: interval jobs must land in `scheduled`, the startup job in
`queued` — proving the kernel represented the job in a **non-running** lifecycle state without
executing it. `encode ∘ decode = identity` ⇒ **parity 100%**.

## 7. Feature flags (only two; default OFF) — G1.0 §3

| Flag | Effect | Default |
|---|---|---|
| `PLATFORM_JOBS` | Inject the Jobs kernel port into the adapter. | `0` |
| `SHADOW_JOBS` | Additionally run parity comparisons. Requires `PLATFORM_JOBS=1`. | `0` |

`selectJobsFlags()` enforces `SHADOW_JOBS ⊂ PLATFORM_JOBS`. Both OFF ⇒ **byte-identical to
Phase 17.4** (test-proven).

## 8. Boundaries honored (Architecture Constraints)

Runtime/API/startup/shutdown/scheduling/timing/execution-ownership/persistent-state ownership
all preserved; no production job executed; kernel never authoritative; never modifies app or
persistent state; never blocks; never throws to callers; always returns legacy behavior. Only
the Jobs Adapter talks to the kernel. Among tracked files only `.env.example` changed; all
changes are additive modules. No other kernel is consumed (STOP boundary respected).
