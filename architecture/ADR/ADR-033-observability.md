# ADR-033 — Enterprise Observability Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.4 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-026 (Audit) — and observes every kernel
ADR-016 … ADR-032 through their existing ports.

## Context

The platform needs one deterministic way to report health, aggregate metrics, generate
runtime diagnostics, carry trace context, and give runtime visibility across every Kernel
Service — independent of any monitoring product. This is the Observability Kernel. It is
**not Prometheus / OpenTelemetry / Grafana / Datadog** and **not a logging framework** —
those are export-provider extension points, not dependencies.

Observability logic must never be embedded in individual services (each rolling its own
health endpoint and metric shape). Instead it is a Kernel Service behind a narrow port, so
every component reports the same way and health/metrics are aggregated in exactly one place.

To stay strictly additive, the kernel lives under `observability/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Observability Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `component.js` — the Component value object (componentId, namespace, service, healthStatus,
  counters, gauges, timers, traceContext, metadata, version, `checksum`, timestamp) with a
  deterministic `report()` merge (counters ADD, gauges SET, timers accumulate).
- `health.js` — the health lattice (healthy/degraded/failed/unknown) + a worst-of
  `aggregate`.
- `aggregation.js` — deterministic metric aggregation (counters/gauges sum, timers merge,
  order-independent) + a health breakdown.
- `redaction.js` — masks sensitive metadata (secret/token/password/apiKey/…) for
  diagnostics.
- `errors.js` — `ObservabilityError`, `ObservabilityValidationError`,
  `ComponentNotFoundError`, `IntegrityError`.
- `events.js` — the event catalog (MetricsCollected, SnapshotCreated, HealthChanged,
  DiagnosticsGenerated, VerificationCompleted); producer `observability`.

**Application (ports & adapters):**

- `providerPort.js` — the STORE/EXPORT-ONLY contract (exportMetrics / putSnapshot /
  getSnapshot / listSnapshots / health) + declared extension points (Prometheus,
  OpenTelemetry, Grafana, Datadog, cloud monitoring, custom). Providers store/export; the
  engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process snapshot store + export sink.
- `metrics.js` — registered / healthy / degraded / failed components (gauges), metrics
  collected, diagnostic snapshots, verification runs, provider failures, collection
  latency, uptime; Prometheus.
- `observabilityPort.js` — the abstraction contract (`assertObservability`): register,
  collect, snapshot, diagnostics, verify, health.
- `observabilityService.js` — the kernel: a component registry, deterministic metric +
  health aggregation, runtime diagnostics (with redaction), component + snapshot
  verification, snapshot generation, trace context propagation, failure aggregation, and
  historical snapshots. Per-component reports are atomic via a serialization mutex.
- `sdkAdapter.js` — `toObservabilityPort(observability, { owner, canRead, canDiagnostics })`:
  namespace isolation + `observability:read` / `observability:diagnostics` enforcement.
- `index.js` — `createObservabilityPlatform(deps)` composition root.

## Kernel integration

Per §5, the Observability Kernel integrates with other kernels **only through their existing
ports** — the Event Backbone (EventPublisher) for its own events; every kernel reports via
`collect()` using the data it already exposes through its `metrics.snapshot()` / `health()`
ports; Audit (ADR-026) can record observability events; Storage (ADR-021) is the model
behind a durable snapshot provider; Configuration (ADR-019) supplies thresholds. It imports
no implementation classes and reads no kernel internals.

## Alternatives rejected

- **Prometheus / OpenTelemetry / Grafana / Datadog as a dependency** — rejected: couples the
  platform to an external monitoring product. They remain export-provider extension points.
- **A logging framework** — rejected: this kernel is structured health/metric/diagnostic
  aggregation, not log shipping.
- **Reading kernel internals directly** — rejected: components self-report via `collect()`
  through the port; the kernel never reaches into another kernel.
- **Provider-side aggregation** — rejected: aggregation, health, diagnostics, and
  verification live in the engine so behavior is uniform regardless of exporter.

## Consequences

- New files under `src/domain/observability/**` and `src/application/observability/**`, plus
  `tests/unit/observability.test.js` (+17 tests). Zero hot-path change; A/B byte-identical.
- Real exporters (Prometheus/OTel/Grafana/Datadog/cloud), durable snapshot retention, and
  distributed trace collection are future work behind the provider port. The memory provider
  is single-process.

## Rollback

Delete `src/domain/observability/`, `src/application/observability/`, and
`tests/unit/observability.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-032) is unchanged. See `docs/OBSERVABILITY-ROLLBACK-PLAN.md`.
