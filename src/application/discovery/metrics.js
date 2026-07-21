'use strict';

/**
 * Service Discovery metrics (Phase 15.5 / ADR-034 §8) — observability port. Tracks
 * registered services + instances (gauges), discoveries, cache hits/misses, health
 * changes, provider failures, resolution latency, and engine uptime; exposes a
 * Prometheus exposition. Pure in-process counters; an injectable clock keeps latency
 * + uptime deterministic.
 */

function createDiscoveryMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let discoveries = 0;
  let resolutions = 0;
  let unavailable = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let healthChanges = 0;
  let verifications = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeServices = () => 0;
  let gaugeInstances = () => 0;
  function bindGauges({ services, instances }) {
    if (services) gaugeServices = services;
    if (instances) gaugeInstances = instances;
  }

  const recordDiscovery = () => (discoveries += 1);
  const recordResolution = () => (resolutions += 1);
  const recordUnavailable = () => (unavailable += 1);
  const recordCacheHit = () => (cacheHits += 1);
  const recordCacheMiss = () => (cacheMisses += 1);
  const recordHealthChange = () => (healthChanges += 1);
  const recordVerification = () => (verifications += 1);
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
      registeredServices: gaugeServices(),
      registeredInstances: gaugeInstances(),
      discoveries,
      resolutions,
      unavailable,
      cacheHits,
      cacheMisses,
      healthChanges,
      verifications,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgResolutionLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastResolutionLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('discovery_registered_services', 'Registered services', s.registeredServices),
        g('discovery_registered_instances', 'Registered instances', s.registeredInstances),
        g('discovery_discoveries_total', 'Discovery queries', s.discoveries),
        g('discovery_resolutions_total', 'Resolutions', s.resolutions),
        g('discovery_unavailable_total', 'Unavailable resolutions', s.unavailable),
        g('discovery_cache_hits_total', 'Provider cache hits', s.cacheHits),
        g('discovery_cache_misses_total', 'Provider cache misses', s.cacheMisses),
        g('discovery_health_changes_total', 'Health changes', s.healthChanges),
        g('discovery_provider_failures_total', 'Provider failures', s.providerFailures),
        g('discovery_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'discovery_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g(
          'discovery_resolution_latency_ms_avg',
          'Average resolution latency',
          s.avgResolutionLatencyMs
        ),
        g(
          'discovery_resolution_latency_ms_last',
          'Last resolution latency',
          s.lastResolutionLatencyMs
        ),
        g('discovery_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordDiscovery,
    recordResolution,
    recordUnavailable,
    recordCacheHit,
    recordCacheMiss,
    recordHealthChange,
    recordVerification,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createDiscoveryMetrics };
