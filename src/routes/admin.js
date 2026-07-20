'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAnalytics } = require('../services/analytics');
// P6-05B: read system vars from env.js instead of process.env directly
const { NODE_ENV, PORT, TZ } = require('../config/env');

module.exports = function createAdminRouter(svc) {
  const router = express.Router();
  const {
    dbGet,
    dbRun,
    dbAll,
    dbTransaction,
    authenticateAdmin,
    io,
    createBackup,
    formatTrip,
    getMetrics,
    validateCoords,
    logger,
    userRepo,
    driverRepo,
    tripRepo,
    reportRepo,
    notifService, // P6-03
    revokeAllRefreshTokens,
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
      if (trip.driver_id) await driverRepo.setTaxiStatus(trip.driver_id, 'online');
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

  // ─── GET /admin/users/:phone — بحث مباشر بمستخدم واحد (Phase 5) ───────────
  router.get('/admin/users/:phone', authenticateAdmin, async (req, res) => {
    try {
      const user = await userRepo.findByPhone(req.params.phone);
      if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      res.json({ success: true, user });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
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

  // GET /admin/drivers/pending — قائمة السائقين بانتظار الموافقة
  // ملاحظة: يجب تسجيله قبل /admin/drivers/:phone وإلا التقطه المسار المُعامَل
  // (:phone="pending") فأعاد 404 — إصلاح تظليل المسارات (route shadowing).
  router.get('/admin/drivers/pending', authenticateAdmin, async (req, res) => {
    try {
      const pending = await driverRepo.findPending();
      res.json({ success: true, count: pending.length, drivers: pending });
    } catch (err) {
      logger.error('admin pending drivers error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ─── GET /admin/drivers/:phone — بحث مباشر بسائق واحد ───────────
  router.get('/admin/drivers/:phone', authenticateAdmin, async (req, res) => {
    try {
      const driver = await driverRepo.findByPhone(req.params.phone);
      if (!driver) return res.status(404).json({ success: false, message: 'السائق غير موجود' });
      res.json({ success: true, driver });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
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

  // ===== P6-06: Driver Approval Workflow =====

  // JS-level mutex per driver phone ─────────────────────────────────────────────
  // عندما يُرسل مشرفان طلبَين متزامنَين على نفس السائق (مثلاً double-approve)،
  // نُسلسل الطلبَين في JS قبل أن يصلا لـ SQLite — يتجنب SQLITE_BUSY تماماً.
  // الطلبات على phones مختلفة تعمل بشكل متوازٍ (لا overhead).
  const driverApprovalLocks = new Map();

  function withDriverLock(phone, fn) {
    // إذا كان هناك عملية جارية على هذا الـ phone، انتظر حتى تنتهي ثم نفّذ fn
    const prev = driverApprovalLocks.get(phone) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    // خزّن نسخة "مستقرة" كـ lock جديد — الطلب التالي سيسلسل بعدها
    const settled = next.catch(() => {});
    driverApprovalLocks.set(phone, settled);
    // تنظيف تلقائي بعد الانتهاء
    settled.then(() => {
      if (driverApprovalLocks.get(phone) === settled) driverApprovalLocks.delete(phone);
    });
    return next; // يُعيد نتيجة fn أو يُرمي خطأها
  }

  // PUT /admin/drivers/:phone/approve — اعتماد سائق
  // P6-06 AUDIT FIX: BEGIN IMMEDIATE → UPDATE → INSERT audit → COMMIT (Atomic)
  // يمنع Double Approval وLost Update عند ضغط مشرفَين في نفس اللحظة.
  router.put('/admin/drivers/:phone/approve', authenticateAdmin, async (req, res) => {
    try {
      const { phone } = req.params;
      const adminPhone = req.user.phone;

      // فحص الوجود خارج الـ transaction (لا حاجة لـ Atomicity هنا)
      const exists = await dbGet('SELECT id FROM drivers WHERE phone = ?', [phone]);
      if (!exists) return res.status(404).json({ success: false, message: 'السائق غير موجود' });

      // withDriverLock: نُسلسل الطلبات المتزامنة على نفس الـ phone (JS mutex)
      // ثم dbTransaction: BEGIN IMMEDIATE للأتومية على مستوى SQLite
      let conflictCode = null;
      await withDriverLock(phone, () =>
        dbTransaction(async () => {
          const fresh = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [phone]);
          if (fresh.approval_status === 'approved') {
            conflictCode = 'ALREADY_APPROVED';
            return;
          }
          await driverRepo.setApprovalStatus(phone, 'approved', { adminPhone });
          await driverRepo.logApprovalAction({
            driverPhone: phone,
            adminPhone,
            action: 'APPROVED',
            ip: req.ip,
          });
        })
      );

      if (conflictCode === 'ALREADY_APPROVED') {
        return res
          .status(400)
          .json({ success: false, code: 'ALREADY_APPROVED', message: 'السائق معتمد بالفعل' });
      }

      logger.security('DRIVER_APPROVED', { adminPhone, driverPhone: phone, ip: req.ip });
      const updated = await driverRepo.findByPhone(phone);
      res.json({ success: true, driver: updated });
    } catch (err) {
      logger.error('admin approve driver error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // PUT /admin/drivers/:phone/reject — رفض سائق مع سبب
  // P6-06 AUDIT FIX: BEGIN IMMEDIATE → UPDATE → INSERT audit → COMMIT (Atomic)
  router.put('/admin/drivers/:phone/reject', authenticateAdmin, async (req, res) => {
    try {
      const { phone } = req.params;
      const { reason } = req.body;
      const adminPhone = req.user.phone;

      if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
        return res
          .status(400)
          .json({ success: false, message: 'سبب الرفض مطلوب (5 أحرف على الأقل)' });
      }
      if (reason.trim().length > 500) {
        return res.status(400).json({ success: false, message: 'سبب الرفض لا يتجاوز 500 حرف' });
      }

      const exists = await dbGet('SELECT id FROM drivers WHERE phone = ?', [phone]);
      if (!exists) return res.status(404).json({ success: false, message: 'السائق غير موجود' });

      const trimmedReason = reason.trim();
      let rejectConflict = null;

      await withDriverLock(phone, () =>
        dbTransaction(async () => {
          // P6-06 FIX: فحص الحالة داخل الـ transaction + withDriverLock
          // يمنع إعادة الرفض المتزامنة من إنتاج 5xx عند concurrent double-reject
          const fresh = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [phone]);
          if (fresh.approval_status === 'rejected') {
            rejectConflict = 'ALREADY_REJECTED';
            return;
          }
          await driverRepo.setApprovalStatus(phone, 'rejected', {
            reason: trimmedReason,
            adminPhone,
          });
          await driverRepo.logApprovalAction({
            driverPhone: phone,
            adminPhone,
            action: 'REJECTED',
            reason: trimmedReason,
            ip: req.ip,
          });
        })
      );

      if (rejectConflict === 'ALREADY_REJECTED') {
        return res
          .status(400)
          .json({ success: false, code: 'ALREADY_REJECTED', message: 'السائق مرفوض بالفعل' });
      }

      logger.security('DRIVER_REJECTED', { adminPhone, driverPhone: phone, ip: req.ip });
      const updated = await driverRepo.findByPhone(phone);
      res.json({ success: true, driver: updated });
    } catch (err) {
      logger.error('admin reject driver error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // PUT /admin/drivers/:phone/suspend — تعليق سائق مع سبب
  // P6-06 AUDIT FIX: BEGIN IMMEDIATE → UPDATE → INSERT audit → COMMIT (Atomic)
  // P6-06 SECURITY FIX: بعد COMMIT يُلغي Access + Refresh Tokens ويُطرد Socket إجبارياً
  router.put('/admin/drivers/:phone/suspend', authenticateAdmin, async (req, res) => {
    try {
      const { phone } = req.params;
      const { reason } = req.body;
      const adminPhone = req.user.phone;

      if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
        return res
          .status(400)
          .json({ success: false, message: 'سبب التعليق مطلوب (5 أحرف على الأقل)' });
      }
      if (reason.trim().length > 500) {
        return res.status(400).json({ success: false, message: 'سبب التعليق لا يتجاوز 500 حرف' });
      }

      const exists = await dbGet('SELECT id FROM drivers WHERE phone = ?', [phone]);
      if (!exists) return res.status(404).json({ success: false, message: 'السائق غير موجود' });

      let conflictCode = null;
      const trimmedReason = reason.trim();

      // ── المرحلة 1: Transaction ذرية (DB) — محمية بـ withDriverLock ────────────
      await withDriverLock(phone, () =>
        dbTransaction(async () => {
          const fresh = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [phone]);
          if (fresh.approval_status === 'suspended') {
            conflictCode = 'ALREADY_SUSPENDED';
            return;
          }
          await driverRepo.setApprovalStatus(phone, 'suspended', {
            reason: trimmedReason,
            adminPhone,
          });
          await driverRepo.logApprovalAction({
            driverPhone: phone,
            adminPhone,
            action: 'SUSPENDED',
            reason: trimmedReason,
            ip: req.ip,
          });
        })
      );

      if (conflictCode === 'ALREADY_SUSPENDED') {
        return res
          .status(400)
          .json({ success: false, code: 'ALREADY_SUSPENDED', message: 'الحساب موقوف بالفعل' });
      }

      // ── المرحلة 2: إلغاء الجلسات (بعد COMMIT — DB state authoritative) ───────
      // 2a. إلغاء Access Token (in-memory + SQLite)
      svc.revokeTokens(phone);

      // 2b. إلغاء جميع Refresh Tokens — P6-06 SECURITY FIX
      // منع السائق من استخدام /auth/refresh للحصول على access token جديد
      await revokeAllRefreshTokens(phone, dbRun);

      // ── المرحلة 3: تنظيف Socket.IO (إجباري — لا يعتمد على استجابة Flutter) ──
      // 3a. إشعار العميل أولاً (يتيح له التنظيف الجانب الخاص به)
      io.to(`driver:${phone}`).emit('force_disconnect', {
        reason: 'account_suspended',
        message: 'تم إيقاف حسابك من قبل المشرف.',
      });

      // 3b. إخراج جميع sockets السائق من غرفة drivers:online إجبارياً
      // P6-06 SECURITY FIX: يمنع السائق من استقبال broadcast new:trip حتى لو تجاهل force_disconnect
      io.in(`driver:${phone}`).socketsLeave('drivers:online');

      // 3c. قطع اتصال Socket.IO كلياً (يغلق الاتصال الفعلي)
      // P6-06 SECURITY FIX: لا يمكن للسائق إعادة الاتصال إلا بـ JWT جديد (محجوب في auth.js)
      io.in(`driver:${phone}`).disconnectSockets(true);

      logger.security('DRIVER_SUSPENDED', { adminPhone, driverPhone: phone, ip: req.ip });

      const updated = await driverRepo.findByPhone(phone);
      res.json({ success: true, driver: updated });
    } catch (err) {
      logger.error('admin suspend driver error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // PUT /admin/drivers/:phone/reactivate — إعادة تفعيل سائق (من rejected أو suspended)
  // P6-06 AUDIT FIX: BEGIN IMMEDIATE → UPDATE → INSERT audit → COMMIT (Atomic)
  router.put('/admin/drivers/:phone/reactivate', authenticateAdmin, async (req, res) => {
    try {
      const { phone } = req.params;
      const adminPhone = req.user.phone;

      const exists = await dbGet('SELECT id FROM drivers WHERE phone = ?', [phone]);
      if (!exists) return res.status(404).json({ success: false, message: 'السائق غير موجود' });

      let conflictCode = null;
      await withDriverLock(phone, () =>
        dbTransaction(async () => {
          const fresh = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [phone]);
          if (fresh.approval_status === 'approved') {
            conflictCode = 'ALREADY_APPROVED';
            return;
          }
          if (fresh.approval_status === 'pending') {
            conflictCode = 'IS_PENDING';
            return;
          }
          await driverRepo.setApprovalStatus(phone, 'approved', { adminPhone });
          await driverRepo.logApprovalAction({
            driverPhone: phone,
            adminPhone,
            action: 'REACTIVATED',
            ip: req.ip,
          });
        })
      );

      if (conflictCode === 'ALREADY_APPROVED') {
        return res
          .status(400)
          .json({ success: false, code: 'ALREADY_APPROVED', message: 'السائق معتمد بالفعل' });
      }
      if (conflictCode === 'IS_PENDING') {
        return res.status(400).json({
          success: false,
          message: 'السائق قيد المراجعة — استخدم Approve لاعتماده',
        });
      }

      logger.security('DRIVER_REACTIVATED', { adminPhone, driverPhone: phone, ip: req.ip });
      const updated = await driverRepo.findByPhone(phone);
      res.json({ success: true, driver: updated });
    } catch (err) {
      logger.error('admin reactivate driver error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // GET /admin/drivers/:phone/approval-history — سجل اعتماد سائق معين
  router.get('/admin/drivers/:phone/approval-history', authenticateAdmin, async (req, res) => {
    try {
      const { phone } = req.params;
      const logs = await dbAll(
        `SELECT id, admin_phone, action, reason, ip, created_at
         FROM driver_approval_logs
         WHERE driver_phone = ?
         ORDER BY created_at DESC LIMIT 50`,
        [phone]
      );
      res.json({ success: true, driverPhone: phone, count: logs.length, history: logs });
    } catch (err) {
      logger.error('admin approval-history error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== إدارة التاكسيات =====
  router.post('/admin/taxis', authenticateAdmin, async (req, res) => {
    try {
      const { name, lat, lng } = req.body;
      // Validation: الاسم مطلوب
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, message: 'اسم التاكسي مطلوب' });
      }
      // Validation: إحداثيات صحيحة (أو افتراضية للكويت)
      const parsedLat = lat != null ? parseFloat(lat) : 29.3765;
      const parsedLng = lng != null ? parseFloat(lng) : 47.9785;
      if (!validateCoords(parsedLat, parsedLng)) {
        return res.status(400).json({ success: false, message: 'إحداثيات غير صحيحة' });
      }
      const result = await dbRun('INSERT INTO taxis (name, lat, lng, status) VALUES (?,?,?,?)', [
        String(name).trim(),
        parsedLat,
        parsedLng,
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
      const integrity = await dbGet('PRAGMA integrity_check');
      const pageCount = await dbGet('PRAGMA page_count');
      const pageSize = await dbGet('PRAGMA page_size');
      const journalMode = await dbGet('PRAGMA journal_mode');
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
          nodeEnv: NODE_ENV,
          port: PORT,
          timezone: TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  // C-006: الإصلاح — WAL checkpoint أولاً ثم restart بعد النسخ
  // بدون checkpoint كانت عملية النسخ تُفسد قاعدة البيانات (WAL mismatch)
  router.post('/admin/db/restore', authenticateAdmin, async (req, res) => {
    try {
      const { filename, confirm } = req.body;

      // تأكيد صريح مطلوب لمنع الاستعادة العرضية
      if (confirm !== 'RESTORE_CONFIRMED') {
        return res.status(400).json({
          success: false,
          message: 'أضف "confirm": "RESTORE_CONFIRMED" في الـ body لتأكيد الاستعادة',
        });
      }

      // P6-07: sanitize filename — whitelist of safe characters only
      // path.basename() strips directory traversal; regex ensures no shell metacharacters
      const safeFilename = path.basename(String(filename || ''));
      if (
        !safeFilename ||
        !/^[\w\-. ]+\.db$/.test(safeFilename) ||
        safeFilename.startsWith('.') ||
        safeFilename !== filename // reject if basename changed (had path components)
      ) {
        return res
          .status(400)
          .json({ success: false, message: 'اسم ملف النسخة الاحتياطية غير صالح' });
      }

      const backupDir = path.join(__dirname, '..', '..', 'backups');
      const backupFile = path.join(backupDir, safeFilename);
      const dbFile = path.join(__dirname, '..', '..', 'oncall.db');

      if (!fs.existsSync(backupFile)) {
        return res
          .status(404)
          .json({ success: false, message: `النسخة غير موجودة: ${safeFilename}` });
      }

      // 1. WAL checkpoint: يضمن كتابة جميع البيانات المعلّقة في الـ WAL إلى ملف DB الرئيسي
      //    قبل النسخ — بدون هذه الخطوة قد تُفسد الاستعادة قاعدة البيانات
      await dbRun('PRAGMA wal_checkpoint(TRUNCATE)');

      // 2. نسخة أمان من الحالة الحالية قبل الاستعادة
      const safetyName = `pre-restore_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
      fs.copyFileSync(dbFile, path.join(backupDir, safetyName));

      // 3. نسخ ملف النسخة الاحتياطية فوق ملف DB الحالي
      fs.copyFileSync(backupFile, dbFile);

      logger.warn(`DB restore: ${filename} → oncall.db (safety: ${safetyName}) — restarting`);

      // 4. إعادة تشغيل الخادم — ضرورية لأن اتصال SQLite الحالي يحتفظ بـ state قديم
      //    مع PM2: يُعاد التشغيل تلقائياً
      //    بدون PM2: يجب تشغيل الخادم يدوياً
      res.json({
        success: true,
        message: `تمت الاستعادة من ${filename}. نسخة أمان: ${safetyName}. الخادم سيُعاد تشغيله...`,
        safetyBackup: safetyName,
        warning: 'يجب إعادة تشغيل الخادم لتفعيل الاستعادة بشكل آمن',
      });

      // تأخير قصير لإرسال الـ response ثم إعادة التشغيل
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      logger.error('DB restore error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== P6-03: Request Metrics =====
  router.get('/admin/metrics', authenticateAdmin, (req, res) => {
    try {
      const m = getMetrics();
      const times = m.responseTimes;
      let avgMs = 0,
        p95Ms = 0,
        minMs = 0,
        maxMs = 0;
      if (times.length) {
        const sorted = [...times].sort((a, b) => a - b);
        avgMs = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        p95Ms = sorted[Math.floor(sorted.length * 0.95)] || 0;
        minMs = sorted[0];
        maxMs = sorted[sorted.length - 1];
      }
      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== P6-03: Security Events =====
  router.get('/admin/security-events', authenticateAdmin, (req, res) => {
    try {
      const n = Math.min(parseInt(req.query.n, 10) || 50, 200);
      res.json({
        success: true,
        count: n,
        events: logger.getSecurityEvents(n),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== P6-03: Recent Errors =====
  router.get('/admin/errors', authenticateAdmin, (req, res) => {
    try {
      const n = Math.min(parseInt(req.query.n, 10) || 100, 200);
      res.json({
        success: true,
        count: n,
        errors: logger.getErrors(n),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== P6-03: Crash Reports =====
  router.get('/admin/crashes', authenticateAdmin, (req, res) => {
    try {
      const n = Math.min(parseInt(req.query.n, 10) || 20, 50);
      res.json({
        success: true,
        count: n,
        crashes: logger.getCrashes(n),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== P6-03: Notification Stats =====
  router.get('/admin/notification-stats', authenticateAdmin, (req, res) => {
    try {
      const stats = notifService?.getStats ? notifService.getStats() : { isConfigured: false };
      res.json({ success: true, notifications: stats });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== إيقاف الخادم (graceful) =====
  // H-007: يتطلب الآن تأكيداً صريحاً في الـ body لمنع الإيقاف العرضي
  router.post('/admin/shutdown', authenticateAdmin, (req, res) => {
    const { confirm } = req.body;
    if (confirm !== 'SHUTDOWN_CONFIRMED') {
      return res.status(400).json({
        success: false,
        message: 'أضف "confirm": "SHUTDOWN_CONFIRMED" في الـ body لتأكيد الإيقاف',
      });
    }
    logger.warn('Server shutdown requested by admin');
    res.json({ success: true, message: 'الخادم سيُوقَف بشكل سلس خلال ثانية...' });
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

      // ─── P6-03: Metrics, Security, Notifications ──────────────────────────────
      const metrics = getMetrics();
      const notifStats = notifService?.getStats ? notifService.getStats() : { isConfigured: false };
      const recentErrors = logger.getErrors(5);
      const recentCrashes = logger.getCrashes(5);

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
          port: PORT,
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

        // ── P6-03: Extended observability ──
        requestMetrics: {
          total: metrics.requestCount,
          error4xx: metrics.error4xxCount,
          error5xx: metrics.error5xxCount,
          slowRoutes: metrics.routes.slice(0, 5),
        },
        notifications: notifStats,
        recentErrors,
        recentCrashes,
      });
    } catch (err) {
      logger.error('dashboard error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};
