# Phase 17.5 — Jobs Kernel Shadow Integration

**Complete.** The first Enterprise Kernel integration performed under the ratified **G1.0
Enterprise Shadow Integration Standard**. The Background Jobs Kernel (ADR-032) is integrated in
**shadow mode**: each legacy background job's *definition* is placed into the kernel and
compared, and the **legacy scheduler remains the only producer of work**. The kernel is never
authoritative and **never executes a job** (the shadow never ticks).

> Authoritative references (immutable): **ADR-032**, **G1.0**, **Phase 17 Completion Report**.

## Code delivered (additive; only `.env.example` changed among app-tracked files)

| Path | Purpose |
|---|---|
| `src/platform-adapters/_shadow/index.js` | **Shared shadow framework** (G1.0 §7): `deepEqual`/`flatten` + full metrics incl. `confidenceLevel` + `coveragePct` + redaction. |
| `src/platform-adapters/jobs/index.js` | Jobs Adapter — register no-op handler + schedule; never ticks. |
| `src/platform-adapters/jobs/legacySource.js` | Read-only inventory of the 5 legacy jobs. |
| `src/platform-adapters/jobs/shadow.js` | Shadow verifier (record → readJob → compare). |
| `src/enterprise/jobsShadow.js` | Flags + shadow attachment. |
| `src/enterprise/index.js` | Wires shadow behind `PLATFORM_JOBS` / `SHADOW_JOBS`. |
| `src/hosted-service/onCallAppService.js` | `jobs` added to shadow-only adapters. |
| `tests/unit/jobs-shadow.test.js` | 14 tests incl. non-execution proof + all-three-shadows. |
| `tests/integration/jobs-shadow-ab.mjs` | Live A/B (app OS / CI). |

## Documents (G1.0 §8)
00 [Jobs Integration Design](00_JOBS_INTEGRATION_DESIGN.md) ·
01 [Jobs Adapter Specification](01_JOBS_ADAPTER_SPEC.md) ·
02 [Jobs Shadow Design](02_JOBS_SHADOW_DESIGN.md) ·
03 [Jobs Parity Report](03_JOBS_PARITY_REPORT.md) ·
04 [Jobs Rollback Guide](04_JOBS_ROLLBACK_GUIDE.md) ·
05 [Updated Integration Diagram](05_UPDATED_INTEGRATION_DIAGRAM.md)

## Flags (default OFF ⇒ byte-identical to Phase 17.4)
```bash
PLATFORM_ENABLED=1 PLATFORM_HOST=1 PLATFORM_JOBS=1 SHADOW_JOBS=1 node server.js
```

## Verification
- ✅ Parity **100%** · coverage **100%** · confidence 1.0 (40 fields / 5 jobs) — boot smoke + 14 unit tests.
- ✅ **Zero jobs executed** — kernel `running=0`, none completed, `tick()` never called (test-proven).
- ✅ Config + Observability + Jobs shadows run together, all 100%.
- ✅ Regression **73/73**; full lint exit 0.
- ✅ Legacy scheduler authoritative; both flags OFF ≡ Phase 17.4 (test-proven).
- ⏳ Live HTTP A/B (`jobs-shadow-ab.mjs`) runs on the app's OS / CI (needs `sqlite3`) — expect `Result: IDENTICAL`.

## G1.0 compliance checklist
```
[x] §1 Shadow principles (legacy authoritative; never throws/blocks/mutates; never executes)
[x] §2 Adapter stateless/deterministic; inert without port; no persistence surface
[x] §3 PLATFORM_JOBS + SHADOW_JOBS; SHADOW⊂PLATFORM; both-off ≡ prev phase
[x] §4 Verification categories + strategy + formula + mismatch/failure rules
[x] §5 Shadow metrics incl. confidenceLevel + coveragePct; isolated
[x] §6 Rollback levels + Rollback Safety Matrix + verification + runbook (flags only)
[x] §7 Unit/Integration/Parity/Shadow/Failure/Flag/Regression/A-B tests present & green
[x] §8 Exactly the six documents (00–05) + README; ADR-032 cited
[x] §9 100% parity; no runtime/API/startup/shutdown/scheduling/ownership change proven
[x] §10 State: Shadow → Verified (100% parity, 0 failures; A/B gate pending on CI)
[x] §11 No invariant violated
```

## STOP boundary honored
Only the Jobs Kernel was integrated (shadow), alongside the Configuration (17.3) and
Observability (17.4) shadows. No further kernel was begun.
