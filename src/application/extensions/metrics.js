'use strict';

/**
 * extension metrics (Phase 14.2 §9) — per-extension observability, exportable to
 * Prometheus. Tracks execution count, average latency, failure rate, health,
 * and load time. Pure in-memory; the registry feeds it.
 */

function createExtensionMetrics(deps = {}) {
  const now = deps.clock || (() => Date.now());
  // extId -> { count, failures, totalLatency, loadTimeMs, health, lastAt }
  const m = new Map();

  function ensure(extId) {
    if (!m.has(extId)) {
      m.set(extId, {
        count: 0,
        failures: 0,
        totalLatency: 0,
        loadTimeMs: 0,
        health: 'unknown',
        lastAt: 0,
      });
    }
    return m.get(extId);
  }

  function record(extId, { latency = 0, ok = true } = {}) {
    const s = ensure(extId);
    s.count += 1;
    if (!ok) s.failures += 1;
    s.totalLatency += latency;
    s.lastAt = now();
  }

  function setLoadTime(extId, ms) {
    ensure(extId).loadTimeMs = ms;
  }
  function setHealth(extId, health) {
    ensure(extId).health = health;
  }

  function snapshot(extId) {
    if (extId) return _view(extId, ensure(extId));
    const out = {};
    for (const [id, s] of m) out[id] = _view(id, s);
    return out;
  }

  function _view(id, s) {
    return {
      extension: id,
      executionCount: s.count,
      failureRate: s.count ? +(s.failures / s.count).toFixed(4) : 0,
      averageLatencyMs: s.count ? +(s.totalLatency / s.count).toFixed(3) : 0,
      loadTimeMs: s.loadTimeMs,
      health: s.health,
      lastActivityAt: s.lastAt ? new Date(s.lastAt).toISOString() : null,
    };
  }

  function remove(extId) {
    m.delete(extId);
  }

  /** Prometheus text exposition for all tracked extensions. */
  function prometheus() {
    const lines = [
      '# HELP oncall_extension_executions_total Hook/capability executions per extension',
      '# TYPE oncall_extension_executions_total counter',
      '# HELP oncall_extension_failures_total Failed executions per extension',
      '# TYPE oncall_extension_failures_total counter',
      '# HELP oncall_extension_latency_ms_avg Average execution latency (ms)',
      '# TYPE oncall_extension_latency_ms_avg gauge',
      '# HELP oncall_extension_load_time_ms Extension load time (ms)',
      '# TYPE oncall_extension_load_time_ms gauge',
      '# HELP oncall_extension_health Extension health (1=healthy,0=unhealthy)',
      '# TYPE oncall_extension_health gauge',
    ];
    for (const [id, s] of m) {
      const l = `{extension="${id}"}`;
      lines.push(`oncall_extension_executions_total${l} ${s.count}`);
      lines.push(`oncall_extension_failures_total${l} ${s.failures}`);
      lines.push(
        `oncall_extension_latency_ms_avg${l} ${s.count ? (s.totalLatency / s.count).toFixed(3) : 0}`
      );
      lines.push(`oncall_extension_load_time_ms${l} ${s.loadTimeMs}`);
      lines.push(`oncall_extension_health${l} ${s.health === 'healthy' ? 1 : 0}`);
    }
    return lines.join('\n') + '\n';
  }

  return { record, setLoadTime, setHealth, snapshot, remove, prometheus };
}

module.exports = { createExtensionMetrics };
