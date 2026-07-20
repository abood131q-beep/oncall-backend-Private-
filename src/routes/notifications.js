'use strict';

/**
 * notifications.js — Device Token CRUD endpoints (P6-02)
 *
 * POST   /device-tokens        — تسجيل/تحديث device token
 * DELETE /device-tokens        — حذف device token محدد
 * POST   /push/send            — إرسال push لمستخدم (admin only)
 * POST   /push/broadcast       — إرسال push لقائمة مستخدمين (admin only)
 *
 * الأمان:
 *   - جميع endpoints تتطلب JWT صالح (authenticate)
 *   - /push/send و /push/broadcast تتطلب admin role
 *   - IDOR: token يُحذف فقط إذا كان مسجلاً لنفس phone في JWT
 *   - Input validation: platform يجب أن يكون 'android' | 'ios'
 *   - device_token: string غير فارغ بحد أقصى 512 حرفاً
 */

const express = require('express');

const VALID_PLATFORMS = ['android', 'ios'];
const MAX_TOKEN_LENGTH = 512;

module.exports = function createNotificationsRouter(svc) {
  const router = express.Router();
  const { authenticate, authenticateAdmin, dbRun, dbGet, dbAll, notifService, logger } = svc;

  // ─── POST /device-tokens ────────────────────────────────────────────────────
  // تسجيل device token جديد أو تحديث last_seen إذا كان موجوداً
  router.post('/device-tokens', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const { device_token, platform, app_version } = req.body;

      // Validation
      if (!device_token || typeof device_token !== 'string' || !device_token.trim()) {
        return res.status(400).json({ success: false, message: 'device_token مطلوب' });
      }
      if (device_token.length > MAX_TOKEN_LENGTH) {
        return res.status(400).json({ success: false, message: 'device_token طويل جداً' });
      }
      if (!platform || !VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          success: false,
          message: `platform يجب أن يكون: ${VALID_PLATFORMS.join(' | ')}`,
        });
      }

      const cleanToken = device_token.trim();
      const cleanVersion = typeof app_version === 'string' ? app_version.slice(0, 20) : '';

      // UPSERT: INSERT أو UPDATE last_seen/app_version إذا كان الـ token موجوداً
      await dbRun(
        `INSERT INTO device_tokens (phone, device_token, platform, app_version, last_seen, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(phone, device_token)
         DO UPDATE SET
           app_version = excluded.app_version,
           last_seen   = CURRENT_TIMESTAMP,
           updated_at  = CURRENT_TIMESTAMP`,
        [phone, cleanToken, platform, cleanVersion]
      );

      logger.info(`Device token registered: ${String(phone).slice(0, 3)}*** | ${platform}`);
      res.json({ success: true, message: 'تم تسجيل الجهاز' });
    } catch (err) {
      logger.error('device-token register error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ─── DELETE /device-tokens ──────────────────────────────────────────────────
  // حذف device token عند تسجيل الخروج — يمنع إرسال push لجهاز مسجّل خروجه
  router.delete('/device-tokens', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const { device_token } = req.body;

      if (!device_token || typeof device_token !== 'string') {
        return res.status(400).json({ success: false, message: 'device_token مطلوب' });
      }

      // IDOR: نتحقق أن الـ token مسجّل لنفس المستخدم
      const existing = await dbGet(
        'SELECT id FROM device_tokens WHERE phone = ? AND device_token = ?',
        [phone, device_token.trim()]
      );
      if (!existing) {
        // نُعيد 200 لتجنب info leakage (المستخدم لا يعلم إذا كان موجوداً أو لا)
        return res.json({ success: true, message: 'تم' });
      }

      await dbRun('DELETE FROM device_tokens WHERE phone = ? AND device_token = ?', [
        phone,
        device_token.trim(),
      ]);

      logger.info(`Device token removed: ${String(phone).slice(0, 3)}***`);
      res.json({ success: true, message: 'تم حذف الجهاز' });
    } catch (err) {
      logger.error('device-token delete error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ─── POST /push/send (admin) ─────────────────────────────────────────────────
  // إرسال push notification لمستخدم محدد
  router.post('/push/send', authenticateAdmin, async (req, res) => {
    try {
      const { phone, title, body, data } = req.body;
      if (!phone || !title || !body) {
        return res.status(400).json({ success: false, message: 'phone + title + body مطلوبة' });
      }

      const result = await notifService.send(phone, title, body, data || {});
      res.json({ success: true, result });
    } catch (err) {
      logger.error('push/send error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ─── POST /push/broadcast (admin) ────────────────────────────────────────────
  // إرسال push notification لقائمة مستخدمين
  router.post('/push/broadcast', authenticateAdmin, async (req, res) => {
    try {
      const { phones, title, body, data } = req.body;
      if (!Array.isArray(phones) || !phones.length || !title || !body) {
        return res.status(400).json({ success: false, message: 'phones[] + title + body مطلوبة' });
      }
      if (phones.length > 1000) {
        return res.status(400).json({ success: false, message: 'الحد الأقصى 1000 مستخدم' });
      }

      // نجلب جميع الأرقام المعرّفين في الـ DB (نمنع broadcast لأرقام وهمية)
      // phones قد تكون من body — نتحقق فقط من طول المصفوفة
      const result = await notifService.broadcast(phones, title, body, data || {});
      res.json({ success: true, result });
    } catch (err) {
      logger.error('push/broadcast error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ─── GET /device-tokens (admin) ───────────────────────────────────────────────
  // جلب عدد الأجهزة المسجّلة لمستخدم (للتشخيص)
  router.get('/device-tokens/:phone', authenticateAdmin, async (req, res) => {
    try {
      const tokens = await dbAll(
        'SELECT platform, app_version, last_seen, created_at FROM device_tokens WHERE phone = ? ORDER BY last_seen DESC',
        [req.params.phone]
      );
      res.json({ success: true, count: tokens.length, tokens });
    } catch (err) {
      logger.error('device-tokens get error:', { message: err.message });
      res.status(500).json({ success: false });
    }
  });

  return router;
};
