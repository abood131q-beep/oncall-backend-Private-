# Phase 17.4 — Observability Integration Design

**Status:** Implemented. **Scope:** integrate the Enterprise Observability Kernel through the
existing Observability Adapter, in **Shadow Mode only**. The legacy OnCall observability
system (`/metrics`, `/health`, `/health/live`, `/health/ready`, the in-process metrics
collector) remains the single Source of Truth. The kernel is never authoritative and its
values are never exposed to the application.

> Note on ADR numbering: the mission text labels this "ADR-020", but the Enterprise
> Observability Kernel is **ADR-033** (ADR-020 is the Scheduler). This phase integrates the
> Observability Kernel; documents reference it as ADR-033.

---

## 1. Objective

Prove that the Observability Kernel can represent every observation the legacy system
produces — health, readiness, liveness, metrics, counters, gauges, timers, event metadata,
and structured-log metadata — by recording a copy through the adapter and comparing, **without
changing** any observability behavior and **without** the kernel ever becoming authoritative.

## 2. Shadow execution model

```
Application
   │
   ▼
Legacy Observability (getMetrics + /health/*)      ← Source of Truth
   │
   ▼
Observability Adapter ─────────► Enterprise Observability Kernel (ADR-033)   [record + read-back]
   │                                     │
   │                                     ▼
   │                            kernel view (never exposed)
   ▼
Shadow Verification (field-by-field deep compare)
   ▼
Shadow Metrics (requests/comparisons/matches/mismatches/failures/latency/parityPct/confidence)
   ▼
RETURN LEGACY RESULT   ← always; kernel never authoritative
```

Implemented in `src/platform-adapters/observability/shadow.js`
(`verify()`, `shadowObserve()`).

## 3. Components (all additive)

| File | Role |
|---|---|
| `src/platform-adapters/observability/index.js` | Observability Adapter — the ONLY kernel-facing surface; encodes a legacy observation into the kernel's `register/collect` shape and decodes `snapshot` back (lossless round-trip). |
| `src/platform-adapters/observability/legacySource.js` | Read-only view over the legacy system (`getMetrics()` + process signals). No DB, no mutation. |
| `src/platform-adapters/observability/metrics.js` | Isolated shadow metrics incl. `confidenceLevel`. |
| `src/platform-adapters/observability/shadow.js` | Shadow verifier: record → read back → compare → record → return legacy. |
| `src/enterprise/observabilityShadow.js` | Flag selection + shadow attachment. |
| `src/enterprise/index.js` | Wires it behind `PLATFORM_OBSERVABILITY` / `SHADOW_OBSERVABILITY`. |

## 4. How parity reaches 100% (lossless round-trip)

The kernel stores counters (ADD), gauges (SET), timers ({count,totalMs,lastMs}), a normalized
health enum, and component `metadata`. The adapter maps the legacy observation onto exactly
those storage semantics and reads them back with a deterministic **codec**:

- **numeric** counters/gauges/timers → pass through (a FRESH component per pass ⇒ counters
  don't accumulate; timers compared via `lastMs`);
- **categorical** health status ↔ kernel enum (`ok↔healthy`, `degraded↔degraded`, …);
- **per-check states** (`ok/warning/error`) → numeric gauges `check.<name>` (0/1/2) decoded
  back to the original strings;
- **booleans** readiness/liveness → gauges `readiness.ready`/`liveness.live` (1/0) decoded
  back to booleans;
- **string metadata** (health tags, event metadata, structured-log metadata) → component
  `metadata` (round-trips exactly).

Because `encode ∘ decode = identity` for every field family, the shadow comparison of the
legacy observation vs the kernel read-back is exact → **parity 100%**.

## 5. Feature flags (only two; default OFF)

| Flag | Effect | Default |
|---|---|---|
| `PLATFORM_OBSERVABILITY` | Inject the Observability kernel port into the adapter. | `0` |
| `SHADOW_OBSERVABILITY` | Additionally run parity comparisons. Requires `PLATFORM_OBSERVABILITY=1`. | `0` |

`selectObservabilityFlags()` enforces that `SHADOW_OBSERVABILITY` cannot activate without
`PLATFORM_OBSERVABILITY`. With both OFF the enterprise boot is **byte-identical to Phase 17.3**
(no port injected, adapter inert, no shadow) — verified by test.

## 6. Boundaries honored

- The application's observability system, `/metrics`, and health endpoints are **unchanged**;
  shadow metrics are a separate, isolated in-memory store.
- Only the Observability Adapter talks to the kernel; **no application module** imports it.
- The parity pass runs out-of-band (after `host.start()`); it never gates readiness/liveness
  and never touches the database.
- Startup and shutdown sequences are unchanged. Among tracked files only `.env.example`
  changed; all changes are additive modules. No other kernel is consumed.
