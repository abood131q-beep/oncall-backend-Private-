# Phase 17.4 — Observability Rollback Guide

Rollback requires **only feature flags** — no code change, no redeploy of different code, no
database migration.

---

## 1. Flags

| Flag | Default | Meaning |
|---|---|---|
| `PLATFORM_OBSERVABILITY` | `0` | Inject the Observability kernel port into the adapter. |
| `SHADOW_OBSERVABILITY` | `0` | Run read-only parity comparisons. Requires `PLATFORM_OBSERVABILITY=1`. |

(Under the Phase 17.2 flags `PLATFORM_ENABLED` / `PLATFORM_HOST` and independent of the
Phase 17.3 config flags.)

## 2. Rollback levels (most surgical → broadest)

| Goal | Action | Effect | Restore time |
|---|---|---|---|
| Stop parity comparisons, keep kernel wired | `SHADOW_OBSERVABILITY=0` | Adapter stays consumed; no comparisons; `shadowObserve` returns legacy with no kernel interaction. | seconds (restart) |
| Disconnect the Observability kernel | `PLATFORM_OBSERVABILITY=0` | Adapter inert; boot identical to Phase 17.3. | seconds |
| Roll back the config shadow too | `PLATFORM_CONFIG=0` | Back to Phase 17.2 behavior. | seconds |
| Leave Enterprise Host | `PLATFORM_HOST=0` | Standalone app (Phase 17.2). | seconds |
| Full bail-out | `PLATFORM_ENABLED=0` | Standalone `server.js`; Platform never instantiated. | seconds |

## 3. Rollback Safety Matrix

At-a-glance impact of each rollback level, for fast incident triage by operations teams. Every
level is a flag flip + process restart — no code change, no redeploy, no migration.

| Rollback Level | Service Impact | User Impact | Data Risk | Downtime |
|---|---|---|---|---|
| `SHADOW_OBSERVABILITY=0` | None | None | None | Restart only |
| `PLATFORM_OBSERVABILITY=0` | None | None | None | Restart only |
| `SHADOW_CONFIG=0` | None | None | None | Restart only |
| `PLATFORM_CONFIG=0` | None | None | None | Restart only |
| `PLATFORM_HOST=0` | None | None | None | Restart only |
| `PLATFORM_ENABLED=0` | None | None | None | Restart only |

**Why every cell is "None":** the kernels consumed so far (Configuration, Observability) are
strictly **shadow / non-authoritative** and memory-only — legacy always produces the served
result and owns all persistent state. Disabling any level removes only the out-of-band
comparison, never a code path the application depends on. The only cost is a rolling restart to
re-read the flag (no request is served differently before or after).

> With a graceful rolling restart (Host drains Socket.IO → HTTP, ≤10 s), the "Downtime" column
> is effectively zero-visible to clients; "Restart only" denotes the mechanism, not an outage.

## 4. Guarantees that make rollback safe

1. **Legacy always authoritative** — the application never consumed a kernel observation, so
   turning the kernel off removes nothing it depended on.
2. **No data at stake** — the Observability kernel is memory-only and fed from legacy; it owns
   no persistent state.
3. **Out-of-band shadow** — the parity pass runs after `host.start()`, never gates
   readiness/liveness, never touches the DB.
4. **Isolated metrics** — shadow metrics are separate from the app's `/metrics`; disabling them
   cannot change the metrics endpoint.
5. **Both flags OFF ≡ Phase 17.3** — verified by test.

## 5. Verifying a rollback

```
# kernel disconnected (PLATFORM_OBSERVABILITY=0):
#   → service.metadata().kernelsConsumed excludes 'observability'
# shadow off (SHADOW_OBSERVABILITY=0):
#   → boot returns observabilityParity === null

node tests/integration/observability-shadow-ab.mjs   # expect: Result: IDENTICAL (app OS / CI)
node --test --test-force-exit tests/unit/observability-shadow.test.js
npm run lint
```

## 6. Incident runbook

1. Identify symptom (unexpected shadow mismatch alerts, latency in the parity pass).
2. Set `SHADOW_OBSERVABILITY=0` (stops comparisons) — or `PLATFORM_OBSERVABILITY=0` to detach.
3. Restart the service.
4. Confirm `/metrics` + `/health*` unchanged and `observabilityParity === null`.
5. Capture `observabilityShadow.stats().mismatches_log` for follow-up before re-enabling.
