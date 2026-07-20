'use strict';

/**
 * observability.js — Production observability endpoints (Phase 12 hardening).
 *
 * ADDITIVE ONLY: three NEW endpoints, no existing contract touched.
 *   GET /metrics       — Prometheus text exposition (ADR-010 M-5 gap closed)
 *   GET /health/live   — Kubernetes liveness  (process is up)
 *   GET /health/ready  — Kubernetes readiness (dependencies reachable)
 *
 * `/metrics` reuses the existing in-process metrics collector — no new state.
 * In a multi-replica deployment each pod exposes its own counters and Prometheus
 * aggregates across pods (standard pull model), so this is correct under scale
 * without any shared store. Secured for production via METRICS_TOKEN (optional
 * bearer) so it is not world-readable; unset ⇒ open (dev parity).
 */

const express = require('express');

function createObservabilityRouter(svc) {
  const { getMetrics, dbGet } = svc;
  const router = express.Router();
  const METRICS_TOKEN = process.env.METRICS_TOKEN || '';

  // ── Prometheus exposition ──────────────────────────────────────────────────
  router.get('/metrics', (req, res) => {
    if (METRICS_TOKEN) {
      const t = (req.headers['authorization'] || '').replace('Bearer ', '');
      if (t !== METRICS_TOKEN) return res.status(401).type('text/plain').send('# unauthorized\n');
    }
    const m = getMetrics();
    const times = m.responseTimes || [];
    const sorted = [...times].sort((a, b) => a - b);
    const p = (q) => (sorted.length ? sorted[Math.floor(sorted.length * q)] || 0 : 0);
    const mem = process.memoryUsage();

    const lines = [];
    const g = (name, help, type, value, labels = '') => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labels} ${value}`);
    };
    g('oncall_up', 'Process liveness (always 1 while serving).', 'gauge', 1);
    g('oncall_uptime_seconds', 'Process uptime in seconds.', 'gauge', Math.round(process.uptime()));
    g('oncall_requests_total', 'Total HTTP requests observed.', 'counter', m.requestCount || 0);
    g('oncall_requests_4xx_total', 'Total 4xx responses.', 'counter', m.error4xxCount || 0);
    g('oncall_requests_5xx_total', 'Total 5xx responses.', 'counter', m.error5xxCount || 0);
    g('oncall_response_time_ms', 'Response time p50 (ms).', 'gauge', p(0.5), '{quantile="0.5"}');
    lines.push(`oncall_response_time_ms{quantile="0.95"} ${p(0.95)}`);
    lines.push(`oncall_response_time_ms{quantile="0.99"} ${p(0.99)}`);
    g('oncall_cpu_percent', 'Approximate CPU utilization percent.', 'gauge', m.cpuPercent || 0);
    g('oncall_heap_used_bytes', 'V8 heap used (bytes).', 'gauge', mem.heapUsed);
    g('oncall_rss_bytes', 'Resident set size (bytes).', 'gauge', mem.rss);
    g(
      'oncall_event_loop_sampled',
      'Sampled request count in the RT window.',
      'gauge',
      times.length
    );

    res.set('Content-Type', 'text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // ── Kubernetes liveness — cheap, no dependencies ───────────────────────────
  router.get('/health/live', (req, res) => {
    res.json({ status: 'live', uptime: Math.round(process.uptime()) });
  });

  // ── Kubernetes readiness — verifies the DB is reachable ────────────────────
  router.get('/health/ready', async (req, res) => {
    try {
      await dbGet('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'database_unreachable' });
    }
  });

  return router;
}

module.exports = { createObservabilityRouter };
