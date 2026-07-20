'use strict';

/**
 * Admin ops gateways — Infrastructure layer.
 * Implements auditRepository / configurationRepository / notificationGateway /
 * loggingGateway by reusing EXISTING integrations (analytics service, logger,
 * metrics, FS backups, PRAGMA maintenance, process lifecycle). The system-level
 * logic that lived inline in the legacy route now lives here, byte-for-byte, so
 * behavior is preserved while the layering is corrected.
 *
 * @param {object} deps — the existing DI service container
 */
const fs = require('fs');
const path = require('path');
const { getAnalytics } = require('../../services/analytics');

function createAdminAuditRepository(deps) {
  const { dbGet, dbAll, logger } = deps;
  return {
    getAnalytics: (period) => getAnalytics(dbGet, dbAll, period),
    getSecurityEvents: (n) => ({ success: true, count: n, events: logger.getSecurityEvents(n) }),
    getErrors: (n) => ({ success: true, count: n, errors: logger.getErrors(n) }),
    getCrashes: (n) => ({ success: true, count: n, crashes: logger.getCrashes(n) }),
  };
}

function createAdminConfigurationRepository(deps) {
  const { dbGet, dbRun, createBackup, logger, NODE_ENV, PORT, TZ } = deps;

  return {
    listBackups() {
      const backupDir = path.join(process.cwd(), 'backups');
      if (!fs.existsSync(backupDir)) return { backups: [] };
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({
          name: f,
          size: fs.statSync(path.join(backupDir, f)).size,
          date: fs.statSync(path.join(backupDir, f)).mtime,
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      return { backups: files };
    },

    createBackup() {
      createBackup();
      return { success: true };
    },

    vacuum: () => dbRun('VACUUM'),
    reindex: () => dbRun('REINDEX'),

    async getDbHealth() {
      const integrity = await dbGet('PRAGMA integrity_check');
      const pageCount = await dbGet('PRAGMA page_count');
      const pageSize = await dbGet('PRAGMA page_size');
      const journalMode = await dbGet('PRAGMA journal_mode');
      const walCheckpoint = await dbGet('PRAGMA wal_checkpoint');
      let dbSizeKB = 0;
      try {
        dbSizeKB = Math.round(fs.statSync(path.join(process.cwd(), 'oncall.db')).size / 1024);
      } catch {
        /* ignore */
      }
      return {
        success: true,
        status: integrity && integrity.integrity_check === 'ok' ? 'healthy' : 'corrupted',
        integrity: integrity ? integrity.integrity_check : 'unknown',
        pageCount: pageCount ? pageCount.page_count : 0,
        pageSize: pageSize ? pageSize.page_size : 0,
        sizeKB: dbSizeKB,
        sizeMB: Math.round((dbSizeKB / 1024) * 100) / 100,
        journalMode: journalMode ? journalMode.journal_mode : 'unknown',
        walCheckpoint: walCheckpoint || null,
      };
    },

    async getSystemInfo() {
      const { exec } = require('child_process');
      const osModule = require('os');
      const mem = process.memoryUsage();
      const cpus = osModule.cpus();
      const freemem = osModule.freemem();
      const totalmem = osModule.totalmem();
      const loadavg = osModule.loadavg();
      const disk = await new Promise((resolve) => {
        exec('df -k .', { timeout: 3000 }, (err, stdout) => {
          if (err || !stdout) return resolve({ totalGB: 0, usedGB: 0, freeGB: 0, usedPercent: 0 });
          try {
            const out = stdout.trim().split('\n')[1].trim().split(/\s+/);
            const totalKB = parseInt(out[1], 10);
            const usedKB = parseInt(out[2], 10);
            const freeKB = parseInt(out[3], 10);
            resolve({
              totalGB: Math.round((totalKB / 1024 / 1024) * 100) / 100,
              usedGB: Math.round((usedKB / 1024 / 1024) * 100) / 100,
              freeGB: Math.round((freeKB / 1024 / 1024) * 100) / 100,
              usedPercent: Math.round((usedKB / totalKB) * 100),
            });
          } catch {
            resolve({ totalGB: 0, usedGB: 0, freeGB: 0, usedPercent: 0 });
          }
        });
      });
      const s = Math.floor(process.uptime());
      return {
        success: true,
        node: {
          version: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
        },
        memory: {
          heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
          externalMB: Math.round((mem.external / 1024 / 1024) * 100) / 100,
          systemFreeMB: Math.round(freemem / 1024 / 1024),
          systemTotalMB: Math.round(totalmem / 1024 / 1024),
          systemUsedPercent: Math.round((1 - freemem / totalmem) * 100),
        },
        cpu: {
          cores: cpus.length,
          model: cpus[0] ? cpus[0].model : 'unknown',
          loadAvg1m: loadavg[0],
          loadAvg5m: loadavg[1],
          loadAvg15m: loadavg[2],
        },
        env: {
          nodeEnv: NODE_ENV,
          port: PORT,
          timezone: TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        uptime: {
          seconds: s,
          human: `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`,
        },
        disk,
      };
    },

    // restore returns { exists, safetyBackup }; performs FS copy + schedules exit.
    async restore(safeFilename) {
      const backupDir = path.join(__dirname, '..', '..', '..', 'backups');
      const backupFile = path.join(backupDir, safeFilename);
      const dbFile = path.join(__dirname, '..', '..', '..', 'oncall.db');
      if (!fs.existsSync(backupFile)) return { exists: false };
      await dbRun('PRAGMA wal_checkpoint(TRUNCATE)');
      const safetyName = `pre-restore_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
      fs.copyFileSync(dbFile, path.join(backupDir, safetyName));
      fs.copyFileSync(backupFile, dbFile);
      logger.warn(`DB restore: ${safeFilename} → oncall.db (safety: ${safetyName}) — restarting`);
      setTimeout(() => process.exit(0), 500);
      return { exists: true, safetyBackup: safetyName };
    },
  };
}

function createAdminNotificationGateway(deps) {
  const { notifService } = deps;
  return {
    getStats: () => ({
      success: true,
      notifications: notifService?.getStats ? notifService.getStats() : { isConfigured: false },
    }),
  };
}

function createAdminLoggingGateway(deps) {
  const { logger, getMetrics } = deps;
  return {
    getLogs(n, level) {
      const entries = logger.getLogs(n, level);
      return {
        success: true,
        count: entries.length,
        filter: { n, level: level ? level.toUpperCase() : 'ALL' },
        logs: entries,
      };
    },
    clearLogs() {
      const result = logger.clearLogs();
      return {
        success: true,
        cleared: result.cleared,
        message: `Cleared ${result.cleared} log entries`,
      };
    },
    getMetrics() {
      const m = getMetrics();
      const times = m.responseTimes;
      let avgMs = 0;
      let p95Ms = 0;
      let minMs = 0;
      let maxMs = 0;
      if (times.length) {
        const sorted = [...times].sort((a, b) => a - b);
        avgMs = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        p95Ms = sorted[Math.floor(sorted.length * 0.95)] || 0;
        minMs = sorted[0];
        maxMs = sorted[sorted.length - 1];
      }
      return {
        success: true,
        requests: {
          total: m.requestCount,
          error4xx: m.error4xxCount,
          error5xx: m.error5xxCount,
          errorRate:
            m.requestCount > 0
              ? Math.round(((m.error4xxCount + m.error5xxCount) / m.requestCount) * 100 * 10) / 10
              : 0,
        },
        performance: {
          avgMs,
          p95Ms,
          minMs,
          maxMs,
          sampledRequests: times.length,
          cpuPercent: m.cpuPercent,
        },
        slowRoutes: m.routes.slice(0, 10),
      };
    },
    scheduleShutdown() {
      logger.warn('Server shutdown requested by admin');
      setTimeout(() => process.exit(0), 1000);
    },
  };
}

module.exports = {
  createAdminAuditRepository,
  createAdminConfigurationRepository,
  createAdminNotificationGateway,
  createAdminLoggingGateway,
};
