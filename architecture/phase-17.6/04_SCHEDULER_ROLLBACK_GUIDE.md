# Phase 17.6 — Scheduler Rollback Guide

Rollback requires **only feature flags** — no code change, no redeploy, no migration. Governed
by G1.0 §6.

---

## 1. Flags

| Flag | Default | Meaning |
|---|---|---|
| `PLATFORM_SCHEDULER` | `0` | Inject the Scheduler kernel port into the adapter. |
| `SHADOW_SCHEDULER` | `0` | Run read-only parity comparisons. Requires `PLATFORM_SCHEDULER=1`. |

(Under the Phase 17.2 flags `PLATFORM_ENABLED` / `PLATFORM_HOST`; independent of the config,
observability, and jobs flags.)

## 2. Rollback levels (most surgical → broadest)

| Goal | Action | Effect | Restore time |
|---|---|---|---|
| Stop parity comparisons, keep kernel wired | `SHADOW_SCHEDULER=0` | Adapter stays consumed; no comparisons; no kernel interaction. | seconds (restart) |
| Disconnect the Scheduler kernel | `PLATFORM_SCHEDULER=0` | Adapter inert; boot identical to Phase 17.5. | seconds |
| Roll back jobs/observability/config shadows too | `PLATFORM_JOBS=0` / `PLATFORM_OBSERVABILITY=0` / `PLATFORM_CONFIG=0` | Back to 17.4 / 17.3 / 17.2. | seconds |
| Leave Enterprise Host | `PLATFORM_HOST=0` | Standalone app (Phase 17.2). | seconds |
| Full bail-out | `PLATFORM_ENABLED=0` | Standalone `server.js`; Platform never instantiated. | seconds |

## 3. Rollback Safety Matrix (G1.0 §6)

| Rollback Level | Service Impact | User Impact | Data Risk | Downtime |
|---|---|---|---|---|
| `SHADOW_SCHEDULER=0` | None | None | None | Restart only |
| `PLATFORM_SCHEDULER=0` | None | None | None | Restart only |
| `PLATFORM_JOBS=0` | None | None | None | Restart only |
| `PLATFORM_OBSERVABILITY=0` | None | None | None | Restart only |
| `PLATFORM_CONFIG=0` | None | None | None | Restart only |
| `PLATFORM_HOST=0` | None | None | None | Restart only |
| `PLATFORM_ENABLED=0` | None | None | None | Restart only |

**Why every cell is "None":** the Scheduler Kernel is shadow / non-authoritative, memory-only,
**never arms a timer**, and **never executes** — the legacy scheduler owns all timing and work.
Disabling any level removes only the out-of-band comparison, never a code path the application
depends on. Cost is a rolling restart to re-read the flag.

## 4. Rollback verification

```
# kernel disconnected (PLATFORM_SCHEDULER=0):
#   → service.metadata().kernelsConsumed excludes 'scheduler'
# shadow off (SHADOW_SCHEDULER=0):
#   → boot returns schedulerParity === null

node tests/integration/scheduler-shadow-ab.mjs   # expect: Result: IDENTICAL (app OS / CI)
node --test --test-force-exit tests/unit/scheduler-shadow.test.js
npm run lint
```

## 5. Incident runbook

1. Identify symptom (unexpected shadow mismatch/verification-failure metrics, latency in the
   parity pass).
2. Set `SHADOW_SCHEDULER=0` (stops comparisons) — or `PLATFORM_SCHEDULER=0` to detach.
3. Restart the service.
4. Confirm the legacy timers are unaffected (they always were), `/health` + `/metrics`
   unchanged, and `schedulerParity === null`.
5. Capture `schedulerShadow.stats().mismatches_log` (sensitive values redacted) for follow-up.

> The legacy background timers never depended on the kernel, so at no rollback level is there
> any risk to scheduled work — `services/backup.js`, `services/cache.js`,
> `app/onCallApplication.js`, and `socket.js` run exactly as before.
