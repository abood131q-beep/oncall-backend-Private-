'use strict';

/**
 * Metric + health aggregation (Phase 15.4 / ADR-033 §3) — PURE domain,
 * deterministic. Rolls many component models into one aggregate: counters SUM,
 * gauges SUM, timers merge (count/totalMs, plus a derived avg), health worst-of.
 * Components are processed in componentId order so the result is stable regardless
 * of insertion order.
 */

const { aggregate: aggregateHealth } = require('./health');

function aggregateMetrics(components = []) {
  const sorted = [...components].sort((a, b) => (a.componentId < b.componentId ? -1 : 1));
  const counters = {};
  const gauges = {};
  const timers = {};
  for (const c of sorted) {
    for (const [k, v] of Object.entries(c.counters || {})) counters[k] = (counters[k] || 0) + v;
    for (const [k, v] of Object.entries(c.gauges || {})) gauges[k] = (gauges[k] || 0) + v;
    for (const [k, t] of Object.entries(c.timers || {})) {
      const acc = timers[k] || { count: 0, totalMs: 0 };
      acc.count += t.count || 0;
      acc.totalMs += t.totalMs || 0;
      timers[k] = acc;
    }
  }
  for (const k of Object.keys(timers)) {
    const t = timers[k];
    t.avgMs = t.count ? t.totalMs / t.count : 0;
  }
  return { counters, gauges, timers, componentCount: sorted.length };
}

/** Health breakdown + rolled-up status across components. */
function aggregateHealthState(components = []) {
  const breakdown = { healthy: 0, degraded: 0, failed: 0, unknown: 0 };
  const statuses = [];
  for (const c of components) {
    const s = c.healthStatus || 'unknown';
    if (breakdown[s] != null) breakdown[s] += 1;
    else breakdown.unknown += 1;
    statuses.push(s);
  }
  return { status: aggregateHealth(statuses), breakdown };
}

module.exports = { aggregateMetrics, aggregateHealthState };
