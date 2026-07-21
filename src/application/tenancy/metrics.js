'use strict';

/**
 * Multi-Tenancy metrics (Phase 15.9 / ADR-038 §8) — observability port. Tracks
 * registered + active tenants (gauges), tenant resolutions, activations,
 * deactivations, verification runs, provider failures, resolution latency, and
 * engine uptime; exposes a Prometheus exposition. Pure in-process counters; an
 * injectable clock keeps latency + uptime deterministic.
 */

function createTenancyMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let resolutions = 0;
  let activations = 0;
  let deactivations = 0;
  let verifications = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let crossTenantBlocks = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeActive = () => 0;
  function bindGauges({ registered, active }) {
    if (registered) gaugeRegistered = registered;
    if (active) gaugeActive = active;
  }

  const recordResolution = () => (resolutions += 1);
  const recordActivation = () => (activations += 1);
  const recordDeactivation = () => (deactivations += 1);
  const recordVerification = () => (verifications += 1);
  const recordCacheHit = () => (cacheHits += 1);
  const recordCacheMiss = () => (cacheMisses += 1);
  const recordCrossTenantBlock = () => (crossTenantBlocks += 1);
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
      registeredTenants: gaugeRegistered(),
      activeTenants: gaugeActive(),
      resolutions,
      activations,
      deactivations,
      verifications,
      cacheHits,
      cacheMisses,
      crossTenantBlocks,
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
        g('tenancy_registered_tenants', 'Registered tenants', s.registeredTenants),
        g('tenancy_active_tenants', 'Active tenants', s.activeTenants),
        g('tenancy_resolutions_total', 'Tenant resolutions', s.resolutions),
        g('tenancy_activations_total', 'Tenant activations', s.activations),
        g('tenancy_deactivations_total', 'Tenant deactivations', s.deactivations),
        g('tenancy_verifications_total', 'Verification runs', s.verifications),
        g('tenancy_cache_hits_total', 'Context cache hits', s.cacheHits),
        g('tenancy_cache_misses_total', 'Context cache misses', s.cacheMisses),
        g('tenancy_cross_tenant_blocks_total', 'Cross-tenant access blocks', s.crossTenantBlocks),
        g('tenancy_provider_failures_total', 'Provider failures', s.providerFailures),
        g('tenancy_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'tenancy_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g(
          'tenancy_resolution_latency_ms_avg',
          'Average resolution latency',
          s.avgResolutionLatencyMs
        ),
        g(
          'tenancy_resolution_latency_ms_last',
          'Last resolution latency',
          s.lastResolutionLatencyMs
        ),
        g('tenancy_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordResolution,
    recordActivation,
    recordDeactivation,
    recordVerification,
    recordCacheHit,
    recordCacheMiss,
    recordCrossTenantBlock,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createTenancyMetrics };
