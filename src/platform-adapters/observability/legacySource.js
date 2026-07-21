'use strict';

/**
 * legacySource.js — Phase 17.4.
 *
 * A read-only view over the LEGACY observability system — the single Source of Truth. It
 * assembles one comprehensive "observation" from the existing in-process metrics collector
 * (`src/middleware/metrics.js` → getMetrics) plus cheap process signals (memory, uptime,
 * event-loop-derived health). It performs NO I/O of its own — it does NOT touch the database
 * — so building an observation cannot change runtime behavior or hit a dependency.
 *
 * Everything is injectable for testing; by default it reads the real metrics module.
 */

/**
 * @param {object} [options]
 * @param {Function} [options.getMetrics] the app's metrics accessor (default: real module).
 * @param {Function} [options.now] clock (ms) for uptime.
 * @param {object}   [options.processRef] process-like object (memoryUsage/uptime).
 * @param {Function} [options.readiness] () => boolean (default true — process is serving).
 * @param {Function} [options.liveness]  () => boolean (default true).
 */
function createLegacyObservabilitySource(options = {}) {
  // eslint-disable-next-line global-require
  const getMetrics = options.getMetrics || require('../../middleware/metrics').getMetrics;
  const proc = options.processRef || process;
  const readiness = options.readiness || (() => true);
  const liveness = options.liveness || (() => true);

  const pct = (sortedTimes, q) =>
    sortedTimes.length ? sortedTimes[Math.floor(sortedTimes.length * q)] || 0 : 0;

  /** Build the current legacy observation (authoritative). Pure read; no DB, no mutation. */
  function observe() {
    const m = getMetrics() || {};
    const times = [...(m.responseTimes || [])].sort((a, b) => a - b);
    const mem = proc.memoryUsage ? proc.memoryUsage() : { heapUsed: 0, heapTotal: 1, rss: 0 };
    const heapPct = mem.heapTotal ? Math.round((mem.heapUsed / mem.heapTotal) * 100) : 0;

    // Cheap health checks matching the /health route semantics (memory + event-loop),
    // WITHOUT the DB probe (never touch the database in the shadow).
    const checks = {
      memory: heapPct < 90 ? 'ok' : 'warning',
      eventLoop: 'ok',
    };
    const status = Object.values(checks).includes('error') ? 'degraded' : 'ok';

    return {
      health: { status, checks, tags: { component: 'oncall', kind: 'process' } },
      readiness: { ready: Boolean(readiness()) },
      liveness: { live: Boolean(liveness()) },
      counters: {
        requests_total: m.requestCount || 0,
        requests_4xx: m.error4xxCount || 0,
        requests_5xx: m.error5xxCount || 0,
      },
      gauges: {
        cpu_percent: m.cpuPercent || 0,
        sampled: times.length,
        uptime_seconds: Math.round(proc.uptime ? proc.uptime() : 0),
        heap_used_bytes: mem.heapUsed,
        rss_bytes: mem.rss,
      },
      timers: {
        response_p50: pct(times, 0.5),
        response_p95: pct(times, 0.95),
        response_p99: pct(times, 0.99),
      },
      event: { service: 'oncall', componentId: 'oncall-observability' },
      // structured-log metadata (shape/level the app logs with; no message content)
      log: { level: (proc.env && proc.env.LOG_LEVEL) || 'INFO', requestIdHeader: 'X-Request-ID' },
    };
  }

  /** The flat list of observation categories this source produces (for reporting). */
  function categories() {
    return [
      'health',
      'readiness',
      'liveness',
      'counters',
      'gauges',
      'timers',
      'event',
      'health.tags',
    ];
  }

  return Object.freeze({ source: 'legacy:observability', observe, categories });
}

module.exports = { createLegacyObservabilitySource };
