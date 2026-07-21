'use strict';

/**
 * Rate-limit metrics (Phase 15.2 / ADR-031 §8) — observability port. Tracks
 * registered policies (gauge), evaluations, allowed requests, blocked requests,
 * quota consumption, quota resets, provider failures, evaluation latency, and
 * engine uptime; exposes a Prometheus exposition. Pure in-process counters; an
 * injectable clock keeps latency + uptime deterministic.
 */

function createRateLimitMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let evaluations = 0;
  let allowed = 0;
  let blocked = 0;
  let consumption = 0;
  let resets = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugePolicies = () => 0;
  function bindGauges({ registeredPolicies }) {
    if (registeredPolicies) gaugePolicies = registeredPolicies;
  }

  const recordEvaluation = () => (evaluations += 1);
  const recordAllowed = () => (allowed += 1);
  const recordBlocked = () => (blocked += 1);
  const recordConsumption = (n = 1) => (consumption += n);
  const recordReset = () => (resets += 1);
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
      registeredPolicies: gaugePolicies(),
      evaluations,
      allowed,
      blocked,
      consumption,
      resets,
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
        g('ratelimit_registered_policies', 'Registered policies', s.registeredPolicies),
        g('ratelimit_evaluations_total', 'Evaluations', s.evaluations),
        g('ratelimit_allowed_total', 'Allowed requests', s.allowed),
        g('ratelimit_blocked_total', 'Blocked requests', s.blocked),
        g('ratelimit_quota_consumed_total', 'Quota units consumed', s.consumption),
        g('ratelimit_quota_resets_total', 'Quota resets', s.resets),
        g('ratelimit_cache_hits_total', 'Usage cache hits', s.cacheHits),
        g('ratelimit_cache_misses_total', 'Usage cache misses', s.cacheMisses),
        g('ratelimit_provider_failures_total', 'Provider failures', s.providerFailures),
        g('ratelimit_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'ratelimit_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('ratelimit_evaluation_latency_ms_avg', 'Average evaluation latency', s.avgLatencyMs),
        g('ratelimit_evaluation_latency_ms_last', 'Last evaluation latency', s.lastLatencyMs),
        g('ratelimit_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordEvaluation,
    recordAllowed,
    recordBlocked,
    recordConsumption,
    recordReset,
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

module.exports = { createRateLimitMetrics };
