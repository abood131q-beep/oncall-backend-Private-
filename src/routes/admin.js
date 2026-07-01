'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAnalytics } = require('../services/analytics');

module.exports = function createAdminRouter(svc) {
  const router = express.Router();
  const {
    dbGet,
    dbRun,
    dbAll,
    authenticateAdmin,
    io,
    createBackup,
    formatTrip,
    getMetrics,
    logger,
    userRepo,
    driverRepo,
    tripRepo,
    reportRepo,
  } = svc;

  // ===== إحصائيات عامة =====
  router.get('/admin/stats', authenticateAdmin, async (req, res) => {
    try {
      const totalTrips = await dbGet('SELECT COUNT(*) as c FROM trips');
      const totalDrivers = await dbGet('SELECT COUNT(*) as c FROM drivers');
      const totalUsers = await dbGet('SELECT COUNT(*) as c FROM users');
      const revenue = await dbGet(
        "SELECT SUM(final_fare) as total FROM trips WHERE status='completed'"
      );
      const activeTrips = await dbGet(
        "SELECT COUNT(*) as c FROM trips WHERE status IN ('accepted','arrived','in_progress')"
      );
      const onlineDrivers = await dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='online'");

      const todayTrips = await dbGet(
        `SELECT COUNT(*) as c FROM trips WHERE created_at >= datetime('now','start of day')`
      );
      const todayRevenue = await dbGet(
        `SELECT SUM(final_fare) as total FROM trips WHERE status='completed' AND created_at >= datetime('now','start of day')`
      );
      const weekTrips = await dbGet(
        `SELECT COUNT(*) as c FROM trips WHERE created_at >= datetime('now','-7 days')`
      );
      const weekRevenue = await dbGet(
        `SELECT SUM(final_fare) as total FROM trips WHERE status='completed' AND created_at >= datetime('now','-7 days')`
      );

      const dailyStats = await dbAll(`
        SELECT date(created_at) as day, COUNT(*) as trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue
        FROM trips WHERE created_at >= datetime('now','-7 days')
        GROUP BY date(created_at) ORDER BY day ASC
      `);

      const topDrivers = await dbAll(`
        SELECT driver_id, driver_name, COUNT(*) as total_trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as earnings,
          AVG(CASE WHEN rating IS NOT NULL THEN rating END) as avg_rating
        FROM trips WHERE driver_id IS NOT NULL
        GROUP BY driver_id ORDER BY total_trips DESC LIMIT 5
      `);

      res.json({
        totalTrips: totalTrips.c,
        totalDrivers: totalDrivers.c,
        totalUsers: totalUsers.c,
        totalRevenue: revenue.total || 0,
        activeTrips: activeTrips.c,
        onlineDrivers: onlineDrivers.c,
        todayTrips: todayTrips.c,
        todayRevenue: todayRevenue.total || 0,
        weekTrips: weekTrips.c,
        weekRevenue: weekRevenue.total || 0,
        dailyStats,
        topDrivers,
      });
    } catch (err) {
      logger.error('admin stats error:', err.message);
      res.status(500).json({ success: false });
    }
  });

  // ===== إدارة الرحلات =====
  router.get('/admin/trips', authenticateAdmin, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50)); // حد أقصى 100 لمنع DoS
      const status = req.query.status || null;

      const trips = await tripRepo.findPaginated(page, limit, status);
      const total = await tripRepo.count(status);
      res.json({
        trips: trips.map(formatTrip),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.put('/admin/trips/:id/cancel', authenticateAdmin, async (req, res) => {
    try {
      const trip = await tripRepo.findById(req.params.id);
      if (!trip) return res.status(404).json({ success: false });
      await tripRepo.cancelByAdmin(req.params.id);
      if (trip.driver_id)
        await driverRepo.setTaxiStatus(trip.driver_id, 'online');
      io.to(`trip:${req.params.id}`).emit('trip:updated', {
        ...formatTrip(trip),
        status: 'cancelled',
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== إدارة السائقين والمستخدمين =====
  router.get('/admin/drivers', authenticateAdmin, async (req, res) => {
    try {
      res.json(await driverRepo.findAll());
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.get('/admin/users', authenticateAdmin, async (req, res) => {
    try {
      res.json(await userRepo.findAll());
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.put('/admin/users/:phone/toggle', authenticateAdmin, async (req, res) => {
    try {
      const user = await userRepo.findByPhone(req.params.phone);
      if (!user) return res.status(404).json({ success: false });
      const newStatus = user.is_active === 0 ? 1 : 0;
      await userRepo.setActive(req.params.phone, newStatus);
      res.json({ success: true, is_active: newStatus });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.put('/admin/drivers/:phone/toggle', authenticateAdmin, async (req, res) => {
    try {
      const driver = await driverRepo.findByPhone(req.params.phone);
      if (!driver) return res.status(404).json({ success: false });
      const newStatus = driver.is_active === 0 ? 1 : 0;
      await driverRepo.setActive(req.params.phone, newStatus);
      if (!newStatus) await driverRepo.setStatus(req.params.phone, 'offline');
      res.json({ success: true, is_active: newStatus });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== إدارة التاكسيات =====
  router.post('/admin/taxis', authenticateAdmin, async (req, res) => {
    try {
      const { name, lat, lng } = req.body;
      const result = await dbRun('INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)', [
        name,
        lat || 29.3765,
        lng || 47.9785,
        'online',
      ]);
      res.json({ success: true, id: result.lastID });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.delete('/admin/taxis/:id', authenticateAdmin, async (req, res) => {
    try {
      await dbRun('DELETE FROM taxis WHERE id = ?', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== البلاغات =====
  router.get('/admin/reports', authenticateAdmin, async (req, res) => {
    try {
      res.json(await reportRepo.findAll(100));
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.put('/admin/reports/:id/resolve', authenticateAdmin, async (req, res) => {
    try {
      await reportRepo.resolve(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== الأرباح =====
  router.get('/admin/revenue', authenticateAdmin, async (req, res) => {
    try {
      const daily = await dbAll(`
        SELECT date(created_at) as day, COUNT(*) as trips,
          SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as revenue
        FROM trips WHERE created_at >= datetime('now','-30 days')
        GROUP BY date(created_at) ORDER BY day DESC
      `);
      const total = await dbGet("SELECT SUM(final_fare) as t FROM trips WHERE status='completed'");
      const month = await dbGet(
        "SELECT SUM(final_fare) as t FROM trips WHERE status='completed' AND created_at >= datetime('now','-30 days')"
      );
      res.json({ success: true, daily, total: total.t || 0, month: month.t || 0 });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== التحليلات المتقدمة (AnalyticsService) =====
  router.get('/admin/analytics', authenticateAdmin, async (req, res) => {
    try {
      const data = await getAnalytics(dbGet, dbAll, req.query.period);
      res.json(data);
    } catch (err) {
      logger.error('analytics error:', err.message);
      res.status(500).json({ success: false });
    }
  });

  // ===== النسخ الاحتياطية =====
  router.get('/admin/backups', authenticateAdmin, (req, res) => {
    try {
      const backupDir = path.join(process.cwd(), 'backups');
      if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({
          name: f,
          size: fs.statSync(path.join(backupDir, f)).size,
          date: fs.statSync(path.join(backupDir, f)).mtime,
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json({ backups: files });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.post('/admin/backup', authenticateAdmin, (req, res) => {
    try {
      createBackup();
      res.json({ success: true, message: 'تم إنشاء نسخة احتياطية' });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== سجلات الخادم (آخر N سجل) =====
  router.get('/admin/logs', authenticateAdmin, (req, res) => {
    try {
      const n = parseInt(req.query.n, 10) || 50;
      const level = req.query.level || null;
      const entries = logger.getLogs(n, level);
      res.json({
        success: true,
        count: entries.length,
        filter: { n, level: level ? level.toUpperCase() : 'ALL' },
        logs: entries,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== مسح سجلات الخادم =====
  router.post('/admin/logs/clear', authenticateAdmin, (req, res) => {
    try {
      const result = logger.clearLogs();
      res.json({
        success: true,
        cleared: result.cleared,
        message: `Cleared ${result.cleared} log entries`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== صحة قاعدة البيانات =====
  router.get('/admin/db/health', authenticateAdmin, async (req, res) => {
    try {
      // Sequential — wal_checkpoint can lock the DB, causing parallel PRAGMAs to fail
      const integrity     = await dbGet('PRAGMA integrity_check');
      const pageCount     = await dbGet('PRAGMA page_count');
      const pageSize      = await dbGet('PRAGMA page_size');
      const journalMode   = await dbGet('PRAGMA journal_mode');
      const walCheckpoint = await dbGet('PRAGMA wal_checkpoint');
      let dbSizeKB = 0;
      try {
        dbSizeKB = Math.round(
          require('fs').statSync(require('path').join(process.cwd(), 'oncall.db')).size / 1024
        );
      } catch (_) {}
      res.json({
        success: true,
        status: integrity && integrity.integrity_check === 'ok' ? 'healthy' : 'corrupted',
        integrity: integrity ? integrity.integrity_check : 'unknown',
        pageCount: pageCount ? pageCount.page_count : 0,
        pageSize: pageSize ? pageSize.page_size : 0,
        sizeKB: dbSizeKB,
        sizeMB: Math.round((dbSizeKB / 1024) * 100) / 100,
        journalMode: journalMode ? journalMode.journal_mode : 'unknown',
        walCheckpoint: walCheckpoint || null,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== VACUUM قاعدة البيانات =====
  router.post('/admin/db/vacuum', authenticateAdmin, async (req, res) => {
    try {
      await dbRun('VACUUM');
      res.json({
        success: true,
        message: 'VACUUM completed — database compacted and defragmented',
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== إعادة بناء الفهارس =====
  router.post('/admin/db/reindex', authenticateAdmin, async (req, res) => {
    try {
      await dbRun('REINDEX');
      res.json({ success: true, message: 'REINDEX completed — all indexes rebuilt' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== معلومات النظام =====
  // إصلاح H6: استبدال execSync بـ exec() غير المتزامن لتجنب تجميد event loop
  router.get('/admin/system', authenticateAdmin, async (req, res) => {
    try {
      const { exec } = require('child_process');
      const osModule = require('os');
      const mem = process.memoryUsage();
      const cpus = osModule.cpus();
      const freemem = osModule.freemem();
      const totalmem = osModule.totalmem();
      const loadavg = osModule.loadavg();

      // Async disk usage — non-blocking
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
          } catch (_) {
            resolve({ totalGB: 0, usedGB: 0, freeGB: 0, usedPercent: 0 });
          }
        });
      });

      const s = Math.floor(process.uptime());
      res.json({
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
          nodeEnv: process.env.NODE_ENV || 'development',
          port: process.env.PORT || 3000,
          timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        uptime: {
          seconds: s,
          human: `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`,
        },
        disk,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== استعادة نسخة احتياطية =====
  router.post('/admin/db/restore', authenticateAdmin, (req, res) => {
    try {
      const { filename } = req.body;
      if (
        !filename ||
        typeof filename !== 'string' ||
        !filename.endsWith('.db') ||
        filename.includes('/') ||
        filename.includes('..')
      ) {
        return res.status(400).json({ success: false, message: 'Invalid backup filename' });
      }
      const backupDir = require('path').join(__dirname, '..', '..', 'backups');
      const backupFile = require('path').join(backupDir, filename);
      const dbFile = require('path').join(__dirname, '..', '..', 'oncall.db');
      if (!require('fs').existsSync(backupFile)) {
        return res.status(404).json({ success: false, message: `Backup not found: ${filename}` });
      }
      // نسخة احتياطية من الملف الحالي قبل الاستعادة
      const safetyName = `pre-restore_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
      require('fs').copyFileSync(dbFile, require('path').join(backupDir, safetyName));
      require('fs').copyFileSync(backupFile, dbFile);
      res.json({
        success: true,
        message: `Database restored from ${filename}. Safety backup saved as ${safetyName}.`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== إيقاف الخادم (graceful) =====
  router.post('/admin/shutdown', authenticateAdmin, (req, res) => {
    res.json({ success: true, message: 'Server shutting down gracefully in 1 second...' });
    setTimeout(() => process.exit(0), 1000);
  });

  // ===== لوحة المراقبة الشاملة =====
  router.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
      // ─── Database queries (parallel) ─────────────────────────────────────────
      const [
        drvOnline,
        drvBusy,
        drvOffline,
        drvTotal,
        tripsActive,
        tripsWaiting,
        tripsCompleted,
        tripsTodayCompleted,
        tripsTotal,
        scAvail,
        scInUse,
        scMaint,
        scTotal,
        scooterTripsActive,
        totalUsers,
        activeUsersToday,
      ] = await Promise.all([
        dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='online'"),
        dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='busy'"),
        dbGet("SELECT COUNT(*) as c FROM drivers WHERE status='offline'"),
        dbGet('SELECT COUNT(*) as c FROM drivers'),
        dbGet(
          "SELECT COUNT(*) as c FROM trips WHERE status IN ('accepted','arrived','in_progress')"
        ),
        dbGet("SELECT COUNT(*) as c FROM trips WHERE status='waiting_driver'"),
        dbGet("SELECT COUNT(*) as c FROM trips WHERE status='completed'"),
        dbGet(
          "SELECT COUNT(*) as c FROM trips WHERE status='completed' AND created_at >= datetime('now','-1 day')"
        ),
        dbGet('SELECT COUNT(*) as c FROM trips'),
        dbGet("SELECT COUNT(*) as c FROM scooters WHERE status='available'"),
        dbGet("SELECT COUNT(*) as c FROM scooters WHERE status NOT IN ('available','maintenance')"),
        dbGet("SELECT COUNT(*) as c FROM scooters WHERE status='maintenance'"),
        dbGet('SELECT COUNT(*) as c FROM scooters'),
        dbGet("SELECT COUNT(*) as c FROM scooter_rides WHERE status='active'"),
        dbGet('SELECT COUNT(*) as c FROM users'),
        dbGet(
          "SELECT COUNT(DISTINCT user_phone) as c FROM trips WHERE created_at >= datetime('now','-1 day')"
        ),
      ]);

      // ─── Socket.IO stats ──────────────────────────────────────────────────────
      const socketClients = io.engine ? io.engine.clientsCount : 0;
      let passengersOnline = 0;
      let driversOnlineSocket = 0;
      try {
        for (const [roomName] of io.sockets.adapter.rooms) {
          if (roomName.startsWith('passenger:')) passengersOnline++;
        }
        const driversRoom = io.sockets.adapter.rooms.get('drivers:online');
        driversOnlineSocket = driversRoom ? driversRoom.size : 0;
      } catch {}

      // ─── Memory ───────────────────────────────────────────────────────────────
      const mem = process.memoryUsage();
      const memUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;
      const memTotalMB = Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10;
      const rssMB = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
      const externalMB = Math.round((mem.external / 1024 / 1024) * 10) / 10;

      // ─── Database file size ───────────────────────────────────────────────────
      let dbSizeKB = 0;
      try {
        dbSizeKB = Math.round(fs.statSync(path.join(process.cwd(), 'oncall.db')).size / 1024);
      } catch {}

      // ─── Backup info ──────────────────────────────────────────────────────────
      let lastBackup = null;
      let backupCount = 0;
      try {
        const backupDir = path.join(process.cwd(), 'backups');
        if (fs.existsSync(backupDir)) {
          const files = fs
            .readdirSync(backupDir)
            .filter((f) => f.endsWith('.db'))
            .sort();
          backupCount = files.length;
          if (files.length) {
            const last = files[files.length - 1];
            const stat = fs.statSync(path.join(backupDir, last));
            lastBackup = { name: last, date: stat.mtime, sizeKB: Math.round(stat.size / 1024) };
          }
        }
      } catch {}

      // ─── Response time stats ──────────────────────────────────────────────────
      const { responseTimes, cpuPercent } = getMetrics();
      let avgResponseMs = 0;
      let p95ResponseMs = 0;
      let minResponseMs = 0;
      let maxResponseMs = 0;
      if (responseTimes.length) {
        const sorted = [...responseTimes].sort((a, b) => a - b);
        avgResponseMs = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        p95ResponseMs = sorted[Math.floor(sorted.length * 0.95)] || 0;
        minResponseMs = sorted[0];
        maxResponseMs = sorted[sorted.length - 1];
      }

      // ─── Recent logs ──────────────────────────────────────────────────────────
      const recentLogs = logger.getLogs(20);

      // ─── Uptime ───────────────────────────────────────────────────────────────
      const uptimeSec = Math.round(process.uptime());
      const uptimeHuman = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;

      res.json({
        success: true,
        timestamp: new Date().toISOString(),

        // ── Server ──
        server: {
          status: 'online',
          pid: process.pid,
          platform: process.platform,
          nodeVersion: process.version,
          port: process.env.PORT || 3000,
          uptime: uptimeSec,
          uptimeHuman,
        },

        // ── Users ──
        users: {
          total: totalUsers.c,
          activeToday: activeUsersToday.c,
        },

        // ── Passengers (Socket.IO) ──
        passengers: {
          online: passengersOnline,
        },

        // ── Drivers ──
        drivers: {
          online: drvOnline.c,
          busy: drvBusy.c,
          offline: drvOffline.c,
          total: drvTotal.c,
          onlineSocket: driversOnlineSocket,
        },

        // ── Trips ──
        trips: {
          active: tripsActive.c,
          waiting: tripsWaiting.c,
          completedToday: tripsTodayCompleted.c,
          completed: tripsCompleted.c,
          total: tripsTotal.c,
        },

        // ── Scooters ──
        scooters: {
          available: scAvail.c,
          inUse: scInUse.c,
          maintenance: scMaint.c,
          total: scTotal.c,
          activeTrips: scooterTripsActive.c,
        },

        // ── System ──
        system: {
          cpuPercent,
          memoryUsedMB: memUsedMB,
          memoryTotalMB: memTotalMB,
          rssMB,
          externalMB,
          socketClients,
          driversOnlineSocket,
        },

        // ── API performance ──
        performance: {
          avgResponseMs,
          p95ResponseMs,
          minResponseMs,
          maxResponseMs,
          sampledRequests: responseTimes.length,
        },

        // ── Database ──
        database: {
          sizeKB: dbSizeKB,
          sizeMB: Math.round((dbSizeKB / 1024) * 100) / 100,
          walMode: true,
          status: 'connected',
        },

        // ── Backup ──
        backup: {
          last: lastBackup,
          count: backupCount,
        },

        // ── Recent logs (آخر 20 سجل) ──
        recentLogs,
      });
    } catch (err) {
      logger.error('dashboard error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};
