'use strict';

/**
 * metrics.js — Response time + CPU usage tracker
 *
 * يُصدِّر:
 *  - metricsMiddleware : Express middleware يقيس زمن الاستجابة
 *  - getMetrics        : دالة تُعيد الإحصائيات الحالية (تُستخدم في /admin/health)
 */

const _responseTimes = [];
const _RT_WINDOW = 200; // آخر 200 طلب

let _cpuLast = process.cpuUsage();
let _cpuTimeLast = Date.now();
let _cpuPercent = 0;

// تحديث CPU كل 5 ثوانٍ
setInterval(() => {
  const now = Date.now();
  const usage = process.cpuUsage(_cpuLast);
  const elapsed = (now - _cpuTimeLast) * 1000; // microseconds
  _cpuPercent =
    elapsed > 0 ? Math.round(((usage.user + usage.system) / elapsed) * 100 * 10) / 10 : 0;
  _cpuLast = process.cpuUsage();
  _cpuTimeLast = now;
}, 5000);

/**
 * Express middleware — يُسجّل زمن كل طلب في نافذة منزلقة.
 */
function metricsMiddleware(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    _responseTimes.push(Date.now() - t0);
    if (_responseTimes.length > _RT_WINDOW) _responseTimes.shift();
  });
  next();
}

/**
 * يُعيد snapshot من إحصائيات الأداء الحالية.
 * @returns {{ responseTimes: number[], cpuPercent: number }}
 */
function getMetrics() {
  return { responseTimes: _responseTimes, cpuPercent: _cpuPercent };
}

module.exports = { metricsMiddleware, getMetrics };
