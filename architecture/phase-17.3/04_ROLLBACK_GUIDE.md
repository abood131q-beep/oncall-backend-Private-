# Phase 17.3 — Rollback Guide

Rollback requires **only feature flags** — no code change, no redeploy of different code, no
database migration. Every step is a flag flip + restart.

---

## 1. Flags

| Flag | Default | Meaning |
|---|---|---|
| `PLATFORM_CONFIG` | `0` | Compose + seed the Config kernel; inject its port into the Configuration Adapter. |
| `SHADOW_CONFIG` | `0` | Run read-only parity comparisons. Requires `PLATFORM_CONFIG=1`. |

(These sit under the Phase 17.2 flags `PLATFORM_ENABLED` / `PLATFORM_HOST`, which select
Enterprise vs Legacy boot.)

## 2. Rollback levels (most surgical → broadest)

| Goal | Action | Effect | Restore time |
|---|---|---|---|
| Stop parity comparisons, keep kernel wired | `SHADOW_CONFIG=0` | Adapter stays consumed; no comparisons run; `shadowGet` returns legacy with zero kernel reads. | seconds (restart) |
| Disconnect the Config kernel entirely | `PLATFORM_CONFIG=0` | Adapter goes inert (`consumed()==[]`); kernel not seeded; boot identical to Phase 17.2. | seconds |
| Leave Enterprise Host, back to legacy process | `PLATFORM_HOST=0` | App boots standalone (Phase 17.2 §rollback). | seconds |
| Full bail-out | `PLATFORM_ENABLED=0` | Standalone `server.js`; Platform never instantiated. | seconds |

## 3. Guarantees that make rollback safe

1. **Legacy always authoritative** — the application never consumed a kernel value at any
   point, so turning the kernel off removes nothing the app depended on.
2. **No data at stake** — the Config kernel is memory-only and seeded from legacy; it owns no
   persistent state. Rolling back cannot lose or corrupt data.
3. **Out-of-band shadow** — the parity pass runs after `host.start()` and never gates
   readiness, so disabling it cannot affect startup/shutdown.
4. **Both flags OFF ≡ Phase 17.2** — verified by test
   (`boot with both flags OFF is identical to 17.2`).

## 4. Verifying a rollback

After flipping flags and restarting:

```bash
# kernel disconnected (PLATFORM_CONFIG=0): adapter inert
#   → service.metadata().kernelsConsumed === []   and   phase === '17.2'
# shadow off (SHADOW_CONFIG=0): no comparisons
#   → boot returns parity === null

node tests/integration/config-shadow-ab.mjs   # expect: Result: IDENTICAL (app OS / CI)
npm run lint && npm run test:unit             # config-shadow + regression green
```

## 5. Incident runbook

1. Identify symptom (e.g. unexpected shadow mismatch alerts, latency in the parity pass).
2. Set `SHADOW_CONFIG=0` (stops all comparisons) — or `PLATFORM_CONFIG=0` to fully detach the
   kernel.
3. Restart the service.
4. Confirm `/health` unchanged and (in enterprise mode) `parity === null` / adapter inert.
5. File the mismatch/failure descriptors from `configShadow.stats().mismatches_log` (values
   are redacted for sensitive keys) for follow-up before re-enabling.
