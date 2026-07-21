# Phase 17.1 — Integration Roadmap (STEP 4)

Small, independent migration sub-phases. **Every sub-phase is reversible, testable,
additive, zero-downtime, and Flutter-safe.** Each reuses the repository's existing proven
mechanism: an env flag (default OFF for new coupling) + the A/B byte-compatibility harness
(`tests/integration/*-ab.mjs`, `npm run test:ab`).

**Global invariants for all sub-phases**
- No route, response body, status code, header, DB schema, auth token, or Socket.IO
  event/payload changes.
- New behavior is guarded by a flag defaulting to the current behavior; flipping the flag OFF
  is a full rollback with no code change.
- A sub-phase merges only when: unit tests green, A/B harness shows byte-identical responses,
  `platform.verify()` OK, and health/readiness endpoints unchanged.

---

## Sub-phase 17.1.0 — Baseline & Harness Lock (no product change)
**Goal:** freeze a reference. **Additive:** yes. **Reversible:** N/A (read-only).
- Capture golden outputs of every route + Socket.IO event via the existing A/B harness and
  `integration-test.mjs`; record current `/health`, `/health/ready`, `/metrics` bodies.
- Confirm `createPlatform().verify()` passes in isolation (already covered by
  `tests/unit/*`), with the app untouched.
**Exit test:** golden snapshots stored; platform verifies standalone.
**Rollback:** nothing to roll back.

---

## Sub-phase 17.1.1 — Compose-but-don't-consume (Platform lights up, app ignores it)
**Goal:** instantiate the Platform/Runtime in-process without any component depending on it.
**Flag:** `PLATFORM_ENABLED` (default `0`). **Additive:** yes. **Zero-downtime:** yes.
- When `PLATFORM_ENABLED=1`, a new boot entry calls `bootstrap()` → `createHost()`; the app
  is **not yet** registered as a hosted service — Platform simply runs beside the app.
- Because the Platform is strictly additive and uses only in-memory providers, it holds no
  app state and touches no route.
**Exit test:** with flag ON, A/B harness byte-identical vs baseline; Runtime `ready()` true;
memory/CPU delta within budget. With flag OFF, identical to 17.1.0.
**Rollback:** `PLATFORM_ENABLED=0`.

---

## Sub-phase 17.1.2 — Config mirror (first, safest consumer)
**Goal:** Config kernel mirrors `env.js` read-only. **Flag:** `PLATFORM_CONFIG=0`.
- A Context Adapter seeds Config's `envProvider` from the exact values `env.js` already
  computed. `env.js` stays the single source of truth; the app reads nothing from Config yet
  (or reads through an adapter that provably returns identical values).
**Why first:** Config is the universal kernel dependency and has an existing `envProvider`;
mirroring is inert.
**Exit test:** adapter returns byte-identical values for every consumed key; fail-fast on
missing `JWT_SECRET` preserved.
**Rollback:** `PLATFORM_CONFIG=0` (app uses `env.js` directly, as today).

---

## Sub-phase 17.1.3 — App becomes a hosted service (Lifecycle ownership)
**Goal:** register the running app as `OnCallAppService` under the Host so Lifecycle owns
startup ordering, readiness gating, health aggregation, and reverse-order shutdown.
**Flag:** `PLATFORM_HOST=0`. **This is the highest-value sub-phase.**
- `OnCallAppService.start()` = current `server.js` steps 2–9 (migrations → revocation store →
  rate-limit store → optional Redis → WAL timer → ghost cleanup → `server.listen` → backup
  schedule). `stop()` = current graceful shutdown (io.close → server.close → 10 s cap).
- With flag OFF, `server.js` boots exactly as today (statement-ordered IIFE).
**Exit test:** identical listen order, identical exit codes on SIGTERM/SIGINT, migrations
still complete before listen, health/readiness bodies unchanged, A/B green.
**Rollback:** `PLATFORM_HOST=0` restores the standalone IIFE boot.

---

## Sub-phase 17.1.4 — Observability feed (metrics/health via kernel, endpoints unchanged)
**Goal:** Observability kernel ingests the app's existing metrics; `/metrics`, `/health`,
`/health/live`, `/health/ready` keep identical output. **Flag:** `PLATFORM_OBS=0`.
- Metrics bridge forwards the counters `metrics.js` already collects; the endpoints continue
  to render from the current source unless the kernel is proven to produce identical bytes.
**Exit test:** endpoint bodies byte-identical; no new latency on hot paths.
**Rollback:** `PLATFORM_OBS=0`.

---

## Sub-phase 17.1.5 — Jobs & Scheduler registration (opt-in, same cadence)
**Goal:** register `backup`, cache-sweep, WAL-checkpoint, hourly taxi auto-fix, and startup
ghost-cleanup as Jobs/Scheduler entries. **Flag:** `PLATFORM_JOBS=0`.
- When OFF, the current `setInterval` timers run exactly as today. When ON, the kernel invokes
  the **same functions** on the **same cadence**; timers remain `.unref()`ed. Exactly one
  scheduler is active at a time (kernel XOR legacy timers) to prevent double-runs.
**Exit test:** each job fires at the same interval and is idempotent; no duplicate backups;
no double taxi auto-fix.
**Rollback:** `PLATFORM_JOBS=0`.

---

## Sub-phase 17.1.6 — Observe-only shadows (Identity / Policy / Ratelimit / Notifications / Audit)
**Goal:** run these kernels in **shadow**: they receive the same inputs and compute results,
which are **compared** to the live path but never served. **Flags:** `SHADOW_IDENTITY`,
`SHADOW_POLICY`, `SHADOW_RATELIMIT`, `SHADOW_NOTIFICATIONS`, `SHADOW_AUDIT` (all default `0`).
- No request-path change; shadow divergences are logged as metrics. This produces the
  evidence needed to later (post-17.1) let a kernel *own* a concern.
**Exit test:** zero behavioral change with any shadow ON; divergence dashboards populate.
**Rollback:** set the specific `SHADOW_*=0`.

---

## Sub-phase 17.1.7 — Deployment wrapper (optional, ops only)
**Goal:** place `createDeployment({host})` above the Host for rollout/rollback/release
strategy of the hosted service. **Flag:** `PLATFORM_DEPLOY=0`.
- Pure ops orchestration; does not alter app behavior. Enables blue/green or rolling restart
  of the hosted service with Runtime health gating.
**Exit test:** a simulated rolling restart keeps readiness green; rollback returns to prior
version.
**Rollback:** `PLATFORM_DEPLOY=0` (use existing `deploy.sh`/`deploy-release.sh`).

---

## Explicitly deferred beyond Phase 17.1 (gated on blockers B1/B2)
These are **not** in 17.1; listed so the boundary is unambiguous.
- **Storage owns the DB** (needs a byte-compatible SQLite/PG Storage provider — blocker B1).
- **Ratelimit/Notifications own persistent state** (need DB-backed providers over
  `rate_limit_locks` / `notifications` / `device_tokens`).
- **Identity owns tokens/refresh/revocation** (needs provider proving identical JWT/claims —
  blocker B2; touches live Flutter tokens).
- **Gateway in the request path** (edge routing/authz) — highest risk to route/response
  compatibility; deferred by design.

---

## Sequencing & Independence

```
17.1.0  Baseline ─┐
17.1.1  Compose   ─┼─ prerequisite for all below
17.1.2  Config    ─┤   (independent of 17.1.3+)
17.1.3  Host/Lifecycle  ← highest value; independent of 17.1.2
17.1.4  Observability   ← independent
17.1.5  Jobs/Scheduler  ← independent
17.1.6  Shadows         ← independent, parallelizable per kernel
17.1.7  Deployment      ← optional, after 17.1.3
```

Each row is an independent, flag-guarded, individually reversible change. None requires the
next. The only ordering constraint is that **17.1.1 (compose)** precedes any consumption, and
**17.1.3 (host)** precedes **17.1.7 (deployment)**.

**Recommended first slice to deliver value with least risk:** 17.1.0 → 17.1.1 → 17.1.3
(lifecycle ownership), then 17.1.2 / 17.1.4 / 17.1.5 in any order.
