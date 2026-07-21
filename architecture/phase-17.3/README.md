# Phase 17.3 — Enterprise Configuration Kernel Integration (Shadow Mode)

**Complete.** The Enterprise Configuration Kernel (ADR-019) is integrated through the existing
Configuration Adapter in **shadow mode**: both systems are read, every value is compared, every
mismatch is recorded, and the **legacy `env.js` value is always returned**. The kernel is never
authoritative and its values are never exposed to the application.

## Code delivered (additive; only `.env.example` changed among app-tracked files)

| Path | Purpose |
|---|---|
| `src/platform-adapters/configuration/index.js` | Configuration Adapter — only kernel-facing surface (`get`, `has`→`exists`, `list`, `version`). |
| `src/platform-adapters/configuration/legacySource.js` | Read-only view over `env.js` (Source of Truth). |
| `src/platform-adapters/configuration/metrics.js` | Shadow metrics (isolated; no runtime effect). |
| `src/platform-adapters/configuration/shadow.js` | Shadow verifier: compare → record → return legacy. |
| `src/enterprise/configShadow.js` | Flags, kernel seeding, shadow attachment. |
| `src/enterprise/index.js` | Wires shadow behind `PLATFORM_CONFIG` / `SHADOW_CONFIG`. |
| `src/hosted-service/onCallAppService.js` | Accepts phase; permits shadow-only consumed adapter. |
| `tests/unit/config-shadow.test.js` | 15 tests: adapter, shadow, parity, flags, failure paths. |
| `tests/integration/config-shadow-ab.mjs` | Live A/B: legacy vs config-shadow (app OS / CI). |

## Documents
00 [Configuration Integration Design](00_CONFIGURATION_INTEGRATION_DESIGN.md) ·
01 [Configuration Adapter Specification](01_CONFIGURATION_ADAPTER_SPEC.md) ·
02 [Shadow Verification Design](02_SHADOW_VERIFICATION_DESIGN.md) ·
03 [Parity Verification Report](03_PARITY_VERIFICATION_REPORT.md) ·
04 [Rollback Guide](04_ROLLBACK_GUIDE.md) ·
05 [Updated Integration Diagram](05_UPDATED_INTEGRATION_DIAGRAM.md)

## Flags (default OFF ⇒ byte-identical to Phase 17.2)
```bash
# both OFF (default): identical to 17.2
PLATFORM_ENABLED=1 PLATFORM_HOST=1 node server.js

# config kernel wired, no comparisons
PLATFORM_ENABLED=1 PLATFORM_HOST=1 PLATFORM_CONFIG=1 node server.js

# full shadow with parity comparisons
PLATFORM_ENABLED=1 PLATFORM_HOST=1 PLATFORM_CONFIG=1 SHADOW_CONFIG=1 node server.js
```

## Verification
- ✅ Parity **100%** (0 mismatches, 0 failures) — boot smoke + 15 unit tests.
- ✅ Regression 48/48 (host + adapters + hosted-service + config-shadow); full lint exit 0.
- ✅ Legacy always authoritative; kernel values never exposed; sensitive keys redacted in
  records; failure path never throws.
- ✅ Both flags OFF ≡ Phase 17.2 (test-proven).
- ⏳ Live HTTP A/B (`config-shadow-ab.mjs`) runs on the app's OS / CI (needs `sqlite3` native
  binding, unavailable in the cross-arch analysis sandbox) — expect `Result: IDENTICAL`.

## STOP boundary honored
Only the Configuration Kernel is consumed (shadow). Identity, Policy, Audit, Storage,
Messaging, Notifications, Rate Limiting, Scheduler, Observability, and Jobs are **not**
integrated.
