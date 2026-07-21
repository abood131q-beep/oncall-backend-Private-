# Phase 17.4 — Enterprise Observability Kernel Integration (Shadow Mode)

**Complete.** The Enterprise Observability Kernel (ADR-033) is integrated through the existing
Observability Adapter in **shadow mode**: every legacy observation is also recorded into the
kernel, compared field-by-field, and the **legacy result is always returned**. The kernel is
never authoritative and its values are never exposed to the application.

> The mission labels this "ADR-020"; the Observability Kernel is actually **ADR-033**
> (ADR-020 is the Scheduler). This phase integrates the Observability Kernel.

## Code delivered (additive; only `.env.example` changed among app-tracked files)

| Path | Purpose |
|---|---|
| `src/platform-adapters/observability/index.js` | Observability Adapter — only kernel-facing surface; lossless encode/decode round-trip. |
| `src/platform-adapters/observability/legacySource.js` | Read-only view over legacy observability (getMetrics + process). |
| `src/platform-adapters/observability/metrics.js` | Isolated shadow metrics incl. `confidenceLevel`. |
| `src/platform-adapters/observability/shadow.js` | Shadow verifier: record → read-back → compare → return legacy. |
| `src/enterprise/observabilityShadow.js` | Flags + shadow attachment. |
| `src/enterprise/index.js` | Wires shadow behind `PLATFORM_OBSERVABILITY` / `SHADOW_OBSERVABILITY`. |
| `src/hosted-service/onCallAppService.js` | `observability` added to shadow-only adapters. |
| `tests/unit/observability-shadow.test.js` | 11 tests: adapter, shadow, parity, flags, failure, both-kernels-together. |
| `tests/integration/observability-shadow-ab.mjs` | Live A/B: legacy vs observability-shadow (app OS / CI). |

## Documents
00 [Observability Integration Design](00_OBSERVABILITY_INTEGRATION_DESIGN.md) ·
01 [Observability Adapter Specification](01_OBSERVABILITY_ADAPTER_SPEC.md) ·
02 [Observability Shadow Design](02_OBSERVABILITY_SHADOW_DESIGN.md) ·
03 [Observability Parity Report](03_OBSERVABILITY_PARITY_REPORT.md) ·
04 [Observability Rollback Guide](04_OBSERVABILITY_ROLLBACK_GUIDE.md) ·
05 [Updated Integration Diagram](05_UPDATED_INTEGRATION_DIAGRAM.md)

## Flags (default OFF ⇒ byte-identical to Phase 17.3)
```bash
# config + observability shadows together
PLATFORM_ENABLED=1 PLATFORM_HOST=1 \
PLATFORM_CONFIG=1 SHADOW_CONFIG=1 \
PLATFORM_OBSERVABILITY=1 SHADOW_OBSERVABILITY=1 node server.js
```

## Verification
- ✅ Parity **100%** (21 fields, 0 mismatches, 0 failures, confidence 1.0) — boot smoke + 11 unit tests.
- ✅ Config + observability shadows run together, both 100%.
- ✅ Regression green (config 15/15, hosted-service 6/6, adapters 6/6, host 21/21); full lint exit 0.
- ✅ Legacy always authoritative; kernel view never exposed; shadow metrics isolated from `/metrics`;
  failure path never throws/blocks.
- ✅ Both flags OFF ≡ Phase 17.3 (test-proven).
- ⏳ Live HTTP A/B (`observability-shadow-ab.mjs`) runs on the app's OS / CI (needs `sqlite3`
  native binding, unavailable in the cross-arch analysis sandbox) — expect `Result: IDENTICAL`.

## STOP boundary honored
Only the Observability Kernel is consumed (shadow), alongside the Configuration shadow from
17.3. Identity, Policy, Audit, Storage, Messaging, Notifications, Scheduler, Jobs, and Rate
Limiting are **not** integrated.
