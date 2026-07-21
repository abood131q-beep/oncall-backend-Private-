# Phase 17.5 — Jobs Parity Report

**Result: Jobs parity = 100%, coverage = 100%, and zero jobs executed.** The legacy scheduler
remains the only producer of work.

---

## 1. Evidence (executed in the analysis environment — no sqlite needed)

The Jobs Kernel is memory-only and tick-driven, so the full shadow ran here against a real
composed Platform + Jobs kernel with a fake application.

**Boot smoke** (real Platform + Jobs kernel, both flags ON):

```
flags             = { platformJobs: true, shadowJobs: true }
adapters.consumed = ["jobs"]
jobsParity        = { enabled: true, jobs: 5, fields: 40, matched: 40, mismatched: 0,
                      mismatchKeys: [], parityPct: 100, confidenceLevel: 1, coveragePct: 100 }
kernel jobs total = 5 | running = 0 | deadLetter = 0        ← NO job executed
```

**Unit suite** (`tests/unit/jobs-shadow.test.js`) — 14/14 pass:

| Area | Result |
|---|---|
| shared metrics expose coveragePct + confidenceLevel | ✅ |
| shared deepEqual/flatten canonical | ✅ |
| adapter inert without a port (async ⇒ rejects) | ✅ |
| toKernelSpec/fromKernelModel/expectedStatus pure & correct | ✅ |
| **shadow 100% parity AND never executes a job** (tick never called; statuses scheduled/queued) | ✅ |
| shadow disabled → no kernel interaction | ✅ |
| failure path → recorded, verify never throws | ✅ |
| mismatch detected when kernel misrepresents a job | ✅ |
| legacy inventory matches the real timers | ✅ |
| flag gating (SHADOW requires PLATFORM) | ✅ |
| boot both-OFF = identical to 17.4 | ✅ |
| boot PLATFORM_JOBS=1, SHADOW_JOBS=0 (wired, no comparisons) | ✅ |
| boot both-ON → parity + coverage 100%, phase 17.5, kernel running=0 | ✅ |
| config + observability + jobs together, all 100% | ✅ |

**Regression:** 73/73 across the Phase-17 suites (jobs, config, observability, hosted-service,
platform-adapters, host). **Lint:** full CI gate → exit 0.

## 2. Parity categories (all matched — 40 fields across 5 jobs)

| Category | Result |
|---|---|
| Job identity (`id` / native `type`) | ✅ |
| Kind (interval/startup) | ✅ |
| Scheduling cadence (`intervalMs`) | ✅ |
| Idempotency | ✅ |
| Ownership | ✅ |
| Enabled | ✅ |
| Lifecycle placement (`status` scheduled/queued — non-execution) | ✅ |

## 3. Acceptance criteria (mission)

| Criterion | Status |
|---|---|
| 100% parity | ✅ |
| 0 mismatches | ✅ |
| 0 verification failures | ✅ |
| No runtime / API / startup / shutdown changes | ✅ (app code untouched; both-off ≡ 17.4) |
| No scheduling / timing / ownership changes | ✅ (out-of-band; never ticks; legacy timers unchanged) |
| No production job executed | ✅ (running=0; never completed; tick never called) |
| Rollback verified | ✅ (flag-only; both-off ≡ 17.4 test) |
| A/B verification | ⏳ run `jobs-shadow-ab.mjs` on app OS / CI → `Result: IDENTICAL` |
| All tests green · Lint green · G1.0 compliance | ✅ / ✅ / ✅ |

## 4. Runtime A/B gate (run on the app's OS / CI)

`tests/integration/jobs-shadow-ab.mjs` boots LEGACY vs ENTERPRISE+JOBS-SHADOW and asserts
byte-identical HTTP responses. It requires the `sqlite3` native binding, so it runs on the
app's normal platform / CI (not the cross-arch analysis environment); auto-discovered by
`scripts/run-ab.mjs`, printing `Result: IDENTICAL` on success.
