'use strict';

/**
 * Configuration metrics (Phase 14.3.2 §10) — observability port. Tracks provider
 * latency, reload duration/count, validation failures, cache hit/miss ratio,
 * subscriber count, and watch notifications. Exposes a Prometheus exposition.
 * Pure in-process counters; an injectable clock keeps timing deterministic.
 */

function createConfigMetrics(opts = {}) {
  const now = opts.clock || (() => Date.now());

  const providerLatency = new Map(); // provider name -> { count, totalMs, lastMs }
  let reloadCount = 0;
  let reloadTotalMs = 0;
  let lastReloadMs = 0;
  let validationFailures = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let subscriberCount = 0;
  let watchNotifications = 0;

  function recordProviderLatency(name, ms) {
    const e = providerLatency.get(name) || { count: 0, totalMs: 0, lastMs: 0 };
    e.count += 1;
    e.totalMs += ms;
    e.lastMs = ms;
    providerLatency.set(name, e);
  }

  /** Time an async provider operation and record its latency. */
  async function timeProvider(name, fn) {
    const start = now();
    try {
      return await fn();
    } finally {
      recordProviderLatency(name, now() - start);
    }
  }

  function recordReload(ms) {
    reloadCount += 1;
    reloadTotalMs += ms;
    lastReloadMs = ms;
  }
  const recordValidationFailure = () => (validationFailures += 1);
  const recordCache = (hit) => (hit ? (cacheHits += 1) : (cacheMisses += 1));
  const setSubscriberCount = (n) => (subscriberCount = n);
  const recordWatchNotification = () => (watchNotifications += 1);

  function snapshot() {
    const cacheTotal = cacheHits + cacheMisses;
    const providers = {};
    for (const [name, e] of providerLatency) {
      providers[name] = { ...e, avgMs: e.count ? e.totalMs / e.count : 0 };
    }
    return {
      providers,
      reloadCount,
      reloadAvgMs: reloadCount ? reloadTotalMs / reloadCount : 0,
      lastReloadMs,
      validationFailures,
      cacheHits,
      cacheMisses,
      cacheHitRatio: cacheTotal ? cacheHits / cacheTotal : 0,
      cacheMissRatio: cacheTotal ? cacheMisses / cacheTotal : 0,
      subscriberCount,
      watchNotifications,
    };
  }

  function prometheus() {
    const s = snapshot();
    const lines = [];
    const g = (name, help, value, labels = '') => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };
    for (const [name, e] of Object.entries(s.providers)) {
      const l = `{provider="${name}"}`;
      lines.push(`config_provider_latency_ms_avg${l} ${e.avgMs}`);
      lines.push(`config_provider_latency_ms_last${l} ${e.lastMs}`);
      lines.push(`config_provider_reads_total${l} ${e.count}`);
    }
    g('config_reload_total', 'Number of reloads', s.reloadCount);
    g('config_reload_duration_ms_avg', 'Average reload duration', s.reloadAvgMs);
    g('config_reload_duration_ms_last', 'Last reload duration', s.lastReloadMs);
    g('config_validation_failures_total', 'Validation failures', s.validationFailures);
    g('config_cache_hit_ratio', 'Cache hit ratio', s.cacheHitRatio);
    g('config_cache_miss_ratio', 'Cache miss ratio', s.cacheMissRatio);
    g('config_subscribers', 'Active watch subscribers', s.subscriberCount);
    g('config_watch_notifications_total', 'Watch notifications delivered', s.watchNotifications);
    return lines.join('\n') + '\n';
  }

  return {
    recordProviderLatency,
    timeProvider,
    recordReload,
    recordValidationFailure,
    recordCache,
    setSubscriberCount,
    recordWatchNotification,
    snapshot,
    prometheus,
  };
}

module.exports = { createConfigMetrics };
