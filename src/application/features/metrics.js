'use strict';

/**
 * Feature-flag metrics (Phase 15.0 / ADR-029 §8) — observability port. Tracks
 * registered / enabled / disabled flags (gauges), evaluations, cache hits/misses,
 * evaluation latency, provider failures, event-publication failures, and engine
 * uptime; exposes a Prometheus exposition. Pure in-process counters; an injectable
 * clock keeps latency + uptime deterministic.
 */

function createFeatureMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let registered = 0;
  let evaluations = 0;
  let rejections = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeEnabled = () => 0;
  let gaugeDisabled = () => 0;
  function bindGauges({ registeredFlags, enabledFlags, disabledFlags }) {
    if (registeredFlags) gaugeRegistered = registeredFlags;
    if (enabledFlags) gaugeEnabled = enabledFlags;
    if (disabledFlags) gaugeDisabled = disabledFlags;
  }

  const recordRegistered = () => (registered += 1);
  const recordEvaluation = () => (evaluations += 1);
  const recordRejection = () => (rejections += 1);
  const recordCacheHit = () => (cacheHits += 1);
  const recordCacheMiss = () => (cacheMisses += 1);
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
      registered,
      registeredFlags: gaugeRegistered(),
      enabledFlags: gaugeEnabled(),
      disabledFlags: gaugeDisabled(),
      evaluations,
      rejections,
      cacheHits,
      cacheMisses,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('features_registered_flags', 'Registered flags', s.registeredFlags),
        g('features_enabled_flags', 'Enabled flags', s.enabledFlags),
        g('features_disabled_flags', 'Disabled flags', s.disabledFlags),
        g('features_evaluations_total', 'Evaluations', s.evaluations),
        g('features_rejections_total', 'Evaluations returning the off value', s.rejections),
        g('features_cache_hits_total', 'Evaluation cache hits', s.cacheHits),
        g('features_cache_misses_total', 'Evaluation cache misses', s.cacheMisses),
        g('features_provider_failures_total', 'Provider failures', s.providerFailures),
        g('features_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'features_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('features_evaluation_latency_ms_avg', 'Average evaluation latency', s.avgLatencyMs),
        g('features_evaluation_latency_ms_last', 'Last evaluation latency', s.lastLatencyMs),
        g('features_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordRegistered,
    recordEvaluation,
    recordRejection,
    recordCacheHit,
    recordCacheMiss,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createFeatureMetrics };
