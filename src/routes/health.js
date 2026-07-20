'use strict';

const express = require('express');

module.exports = function createHealthRouter(svc) {
  const router = express.Router();
  const { dbGet } = svc;

  router.get('/', (req, res) => res.send('On Call Backend 🚀 (Socket.IO)'));

  router.get('/test', (req, res) => res.json({ success: true, message: 'API Works' }));

  // M-004: /health يُعيد معلومات مبسّطة فقط (بدون PII أو system internals)
  // البيانات التفصيلية متاحة في /admin/health المحمي بـ authenticateAdmin
  // P6-03: Enhanced with event loop lag and memory check
  router.get('/health', async (req, res) => {
    const checks = {};

    // Database check
    try {
      await dbGet('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Memory check (warn if heap > 90%)
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    checks.memory = heapPct < 90 ? 'ok' : 'warning';

    // Event loop lag (P6-03)
    const lagStart = process.hrtime.bigint();
    await new Promise((r) => setImmediate(r));
    const lagMs = Number(process.hrtime.bigint() - lagStart) / 1e6;
    checks.eventLoop = lagMs < 100 ? 'ok' : lagMs < 500 ? 'warning' : 'error';

    const overallStatus = Object.values(checks).includes('error') ? 'degraded' : 'ok';

    res.status(overallStatus === 'ok' ? 200 : 503).json({
      status: overallStatus,
      ...checks,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
