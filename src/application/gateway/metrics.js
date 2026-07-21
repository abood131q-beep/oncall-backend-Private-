'use strict';

/**
 * API Gateway metrics (Phase 15.6 / ADR-035 §8) — observability port. Tracks
 * registered routes (gauge), request dispatches, successful + failed resolutions,
 * policy rejections, provider failures, routing latency, and engine uptime; exposes
 * a Prometheus exposition. Pure in-process counters; an injectable clock keeps
 * latency + uptime deterministic.
 */

function createGatewayMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let dispatches = 0;
  let resolvedOk = 0;
  let resolvedFail = 0;
  let policyRejections = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRoutes = () => 0;
  function bindGauges({ routes }) {
    if (routes) gaugeRoutes = routes;
  }

  const recordDispatch = () => (dispatches += 1);
  const recordResolvedOk = () => (resolvedOk += 1);
  const recordResolvedFail = () => (resolvedFail += 1);
  const recordPolicyRejection = () => (policyRejections += 1);
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
      registeredRoutes: gaugeRoutes(),
      dispatches,
      successfulResolutions: resolvedOk,
      failedResolutions: resolvedFail,
      policyRejections,
      cacheHits,
      cacheMisses,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgRoutingLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastRoutingLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('gateway_registered_routes', 'Registered routes', s.registeredRoutes),
        g('gateway_dispatches_total', 'Request dispatches', s.dispatches),
        g('gateway_resolutions_success_total', 'Successful resolutions', s.successfulResolutions),
        g('gateway_resolutions_failed_total', 'Failed resolutions', s.failedResolutions),
        g('gateway_policy_rejections_total', 'Policy rejections', s.policyRejections),
        g('gateway_cache_hits_total', 'Route cache hits', s.cacheHits),
        g('gateway_cache_misses_total', 'Route cache misses', s.cacheMisses),
        g('gateway_provider_failures_total', 'Provider failures', s.providerFailures),
        g('gateway_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'gateway_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('gateway_routing_latency_ms_avg', 'Average routing latency', s.avgRoutingLatencyMs),
        g('gateway_routing_latency_ms_last', 'Last routing latency', s.lastRoutingLatencyMs),
        g('gateway_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordDispatch,
    recordResolvedOk,
    recordResolvedFail,
    recordPolicyRejection,
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

module.exports = { createGatewayMetrics };
