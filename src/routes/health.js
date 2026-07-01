'use strict';

const express = require('express');

module.exports = function createHealthRouter(svc) {
  const router = express.Router();
  const { cache, tripTimers, dbGet } = svc;

  router.get('/', (req, res) => res.send('On Call Backend 🚀 (Socket.IO)'));

  router.get('/test', (req, res) => res.json({ success: true, message: 'API Works' }));

  // إصلاح M9: اختبار DB حقيقي لمنع false-positive حين تكون قاعدة البيانات تالفة
  router.get('/health', async (req, res) => {
    const memUsage = process.memoryUsage();
    let dbStatus = 'ok';
    try {
      await dbGet('SELECT 1');
    } catch {
      dbStatus = 'error';
    }
    const overallStatus = dbStatus === 'ok' ? 'ok' : 'degraded';
    res.status(overallStatus === 'ok' ? 200 : 503).json({
      status: overallStatus,
      db: dbStatus,
      uptime: Math.round(process.uptime()),
      memory: {
        used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      },
      cache: cache.size,
      timers: tripTimers.size,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
