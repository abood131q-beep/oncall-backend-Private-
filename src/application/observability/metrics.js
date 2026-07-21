'use strict';

/**
 * Observability metrics (Phase 15.4 / ADR-033 §8) — the Observability Kernel's OWN
 * observability port. Tracks registered / healthy / degraded / failed components
 * (gauges), metrics collected, diagnostic snapshots, verification runs, provider
 * failures, collection latency, and engine uptime; exposes a Prometheus exposition.
 * Pure in-process counters; an injectable clock keeps latency + uptime deterministic.
 */

function createObservabilityMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let collected = 0;
  let snapshots = 0;
  let diagnostics = 0;
  let verifications = 0;
  let healthChanges = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeHealthy = () => 0;
  let gaugeDegraded = () => 0;
  let gaugeFailed = () => 0;
  function bindGauges({ registered, healthy, degraded, failed }) {
    if (registered) gaugeRegistered = registered;
    if (healthy) gaugeHealthy = healthy;
    if (degraded) gaugeDegraded = degraded;
    if (failed) gaugeFailed = failed;
  }

  const recordCollected = () => (collected += 1);
  const recordSnapshot = () => (snapshots += 1);
  const recordDiagnostics = () => (diagnostics += 1);
  const recordVerification = () => (verifications += 1);
  const recordHealthChange = () => (healthChanges += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      registeredComponents: gaugeRegistered(),
      healthyComponents: gaugeHealthy(),
      degradedComponents: gaugeDegraded(),
      failedComponents: gaugeFailed(),
      metricsCollected: collected,
      diagnosticSnapshots: snapshots,
      diagnosticsRuns: diagnostics,
      verificationRuns: verifications,
      healthChanges,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgCollectionLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastCollectionLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('observability_registered_components', 'Registered components', s.registeredComponents),
        g('observability_healthy_components', 'Healthy components', s.healthyComponents),
        g('observability_degraded_components', 'Degraded components', s.degradedComponents),
        g('observability_failed_components', 'Failed components', s.failedComponents),
        g('observability_metrics_collected_total', 'Metric collections', s.metricsCollected),
        g('observability_snapshots_total', 'Diagnostic snapshots', s.diagnosticSnapshots),
        g('observability_verifications_total', 'Verification runs', s.verificationRuns),
        g('observability_provider_failures_total', 'Provider failures', s.providerFailures),
        g('observability_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'observability_collection_latency_ms_avg',
          'Average collection latency',
          s.avgCollectionLatencyMs
        ),
        g(
          'observability_collection_latency_ms_last',
          'Last collection latency',
          s.lastCollectionLatencyMs
        ),
        g('observability_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordCollected,
    recordSnapshot,
    recordDiagnostics,
    recordVerification,
    recordHealthChange,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createObservabilityMetrics };
