'use strict';

/**
 * metrics.js — Response time + CPU usage + per-route stats tracker (P6-03)
 *
 * يُصدِّر:
 *  - metricsMiddleware : Express middleware يقيس زمن الاستجابة
 *  - getMetrics        : دالة تُعيد الإحصائيات الحالية
 */

const os = require('os');

// ─── Response time sliding window ─────────────────────────────────────────────

const _responseTimes = [];
const _RT_WINDOW = 200; // آخر 200 طلب

// ─── Request counters (P6-03) ─────────────────────────────────────────────────

let _requestCount = 0;
let _error4xxCount = 0;
let _error5xxCount = 0;

// ─── Per-route stats (P6-03) ──────────────────────────────────────────────────
// key: "METHOD /route/path"  →  { count, totalMs, maxMs }
const _routeStats = new Map();
const _ROUTE_MAX = 100; // حد أقصى لعدد المسارات المتعقّبة

// ─── CPU usage ────────────────────────────────────────────────────────────────

let _cpuLast = process.cpuUsage();
let _cpuTimeLast = Date.now();
let _cpuPercent = 0;

const _CPU_COUNT = Math.max(1, os.cpus().length);

// تحديث CPU كل 5 ثوانٍ
setInterval(() => {
  const now = Date.now();
  const usage = process.cpuUsage(_cpuLast);
  const elapsed = (now - _cpuTimeLast) * 1000; // microseconds
  _cpuPercent =
    elapsed > 0
      ? Math.round(((usage.user + usage.system) / elapsed / _CPU_COUNT) * 100 * 10) / 10
      : 0;
  _cpuLast = process.cpuUsage();
  _cpuTimeLast = now;
}, 5000);

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Express middleware — يُسجّل زمن كل طلب، رمز الاستجابة، والمسار.
 */
function metricsMiddleware(req, res, next) {
  const t0 = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - t0;
    const status = res.statusCode;

    // Sliding window for global response times (backward compat)
    _responseTimes.push(duration);
    if (_responseTimes.length > _RT_WINDOW) _responseTimes.shift();

    // Total request count (P6-03)
    _requestCount++;

    // Error counters (P6-03)
    if (status >= 400 && status < 500) _error4xxCount++;
    else if (status >= 500) _error5xxCount++;

    // Per-route stats (P6-03)
    // req.route?.path is set after routing; res.on('finish') fires post-handler
    const routePath = req.route ? req.route.path : null;
    if (routePath) {
      const key = `${req.method} ${routePath}`;

      // Evict smallest-count entry if map is full
      if (!_routeStats.has(key) && _routeStats.size >= _ROUTE_MAX) {
        let minKey = null,
          minCount = Infinity;
        for (const [k, v] of _routeStats) {
          if (v.count < minCount) {
            minCount = v.count;
            minKey = k;
          }
        }
        if (minKey) _routeStats.delete(minKey);
      }

      const s = _routeStats.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
      s.count++;
      s.totalMs += duration;
      if (duration > s.maxMs) s.maxMs = duration;
      _routeStats.set(key, s);
    }
  });

  next();
}

// ─── Stats accessor ───────────────────────────────────────────────────────────

/**
 * يُعيد snapshot من إحصائيات الأداء الحالية.
 * @returns {{ responseTimes, cpuPercent, requestCount, error4xxCount, error5xxCount, routes }}
 */
function getMetrics() {
  // Sort routes by maxMs descending → slowest first
  const routes = [];
  for (const [route, s] of _routeStats) {
    routes.push({
      route,
      count: s.count,
      avgMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
      maxMs: s.maxMs,
      totalMs: s.totalMs,
    });
  }
  routes.sort((a, b) => b.maxMs - a.maxMs);

  return {
    // Backward-compatible
    responseTimes: _responseTimes,
    cpuPercent: _cpuPercent,
    // P6-03
    requestCount: _requestCount,
    error4xxCount: _error4xxCount,
    error5xxCount: _error5xxCount,
    routes,
  };
}

module.exports = { metricsMiddleware, getMetrics };
