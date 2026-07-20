'use strict';

/**
 * Policy metrics (Phase 14.6 / ADR-025 §7) — observability port. Tracks policies
 * registered, policies evaluated, allow/deny decisions, evaluation latency, and
 * decision-cache hits/misses; exposes a Prometheus exposition. Pure in-process
 * counters; injectable clock keeps latency deterministic.
 */

function createPolicyMetrics(opts = {}) {
  void opts;
  let registered = 0;
  let evaluated = 0;
  let allow = 0;
  let deny = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  const recordRegistered = () => (registered += 1);
  const recordDecision = (allowed) => {
    evaluated += 1;
    if (allowed) allow += 1;
    else deny += 1;
  };
  const recordCache = (hit) => (hit ? (cacheHits += 1) : (cacheMisses += 1));
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    const cacheTotal = cacheHits + cacheMisses;
    return {
      registered,
      evaluated,
      allow,
      deny,
      cacheHits,
      cacheMisses,
      cacheHitRatio: cacheTotal ? cacheHits / cacheTotal : 0,
      cacheMissRatio: cacheTotal ? cacheMisses / cacheTotal : 0,
      avgEvaluationLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastEvaluationLatencyMs: latLastMs,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('policy_registered_total', 'Policies registered', s.registered),
        g('policy_evaluated_total', 'Policy evaluations', s.evaluated),
        g('policy_allow_total', 'Allow decisions', s.allow),
        g('policy_deny_total', 'Deny decisions', s.deny),
        g('policy_cache_hits_total', 'Decision cache hits', s.cacheHits),
        g('policy_cache_misses_total', 'Decision cache misses', s.cacheMisses),
        g('policy_cache_hit_ratio', 'Decision cache hit ratio', s.cacheHitRatio),
        g('policy_cache_miss_ratio', 'Decision cache miss ratio', s.cacheMissRatio),
        g(
          'policy_evaluation_latency_ms_avg',
          'Average evaluation latency',
          s.avgEvaluationLatencyMs
        ),
        g(
          'policy_evaluation_latency_ms_last',
          'Last evaluation latency',
          s.lastEvaluationLatencyMs
        ),
      ].join('\n') + '\n'
    );
  }

  return { recordRegistered, recordDecision, recordCache, recordLatency, snapshot, prometheus };
}

module.exports = { createPolicyMetrics };
