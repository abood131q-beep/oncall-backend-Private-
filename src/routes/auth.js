'use strict';

const express = require('express');
// Phase 18.4: config read via the runtime facade (single approved config-read seam).
const config = require('../config');
const REQUIRE_OTP = config.get('REQUIRE_OTP');
const SMS_PROVIDER = config.get('SMS_PROVIDER');
const { sendOTP, verifyOTP } = require('../services/otpService');

module.exports = function createAuthRouter(svc) {
  const router = express.Router();
  const {
    logger,
    ADMIN_PHONES,
    generateJWT,
    verifyJWT,
    authenticate,
    getSession,
    revokeTokens,
    generateRefreshToken,
    verifyRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
    validatePhone,
    loginLimit,
    phoneLoginLimit,
    userRepo,
    driverRepo,
    dbRun,
    dbGet,
  } = svc;

  // ===== P6-04B/D: إرسال OTP =====
  // POST /auth/otp/send — يولّد رمز 6 أرقام، يُخزّنه، ويُرسله عبر SMS
  // P6-04D: محمي بطبقتَي Rate Limit: loginLimit (per IP) + phoneLoginLimit (per phone)
  router.post('/auth/otp/send', loginLimit, phoneLoginLimit, async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
      if (!validatePhone(phone))
        return res.status(400).json({ success: false, message: 'رقم الهاتف غير صحيح' });

      await sendOTP(phone, dbRun, logger, { requestId: req.id, provider: SMS_PROVIDER });
      res.json({ success: true, message: 'تم إرسال رمز التحقق' });
    } catch (err) {
      logger.error('OTP send error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تسجيل دخول الراكب =====
  router.post('/login', loginLimit, phoneLoginLimit, async (req, res) => {
    try {
      const { phone, name, otp } = req.body;
      if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
      if (!validatePhone(phone))
        return res.status(400).json({ success: false, message: 'رقم الهاتف غير صحيح' });

      // P6-04B/D: التحقق من OTP إذا كان مفعَّلاً
      if (REQUIRE_OTP) {
        if (!otp) return res.status(400).json({ success: false, message: 'رمز التحقق مطلوب' });
        const valid = await verifyOTP(phone, String(otp), dbGet, dbRun, {
          logger,
          requestId: req.id,
          provider: SMS_PROVIDER,
        });
        if (!valid)
          return res
            .status(401)
            .json({ success: false, message: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });
      }

      let user = await userRepo.findByPhone(phone);
      if (!user) {
        user = await userRepo.create(phone, name);
      }
      if (user.is_active === 0) {
        return res.status(403).json({ success: false, message: 'الحساب موقوف — تواصل مع الدعم' });
      }

      const isAdmin = ADMIN_PHONES.includes(phone);
      const jwtPayload = {
        phone,
        type: 'passenger',
        name: user.name,
        role: isAdmin ? 'admin' : 'passenger',
      };

      const accessToken = generateJWT(jwtPayload);
      // Admin يحصل على token طويل (24h) فقط — لا refresh token
      const refreshToken = isAdmin ? null : await generateRefreshToken(jwtPayload, dbRun);

      dbRun('INSERT INTO login_logs (phone, type, ip) VALUES (?, ?, ?)', [
        phone,
        'passenger',
        req.ip,
      ]).catch(() => {});

      logger.success(`Passenger login: ${phone.slice(0, 3)}***`);
      res.json({ success: true, user, token: accessToken, refreshToken });
    } catch (err) {
      logger.error('Passenger login error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تسجيل دخول السائق =====
  router.post('/driver/login', loginLimit, phoneLoginLimit, async (req, res) => {
    try {
      const { phone, otp } = req.body;
      if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
      if (!validatePhone(phone))
        return res.status(400).json({ success: false, message: 'رقم الهاتف غير صحيح' });

      // P6-04B/D: التحقق من OTP إذا كان مفعَّلاً
      if (REQUIRE_OTP) {
        if (!otp) return res.status(400).json({ success: false, message: 'رمز التحقق مطلوب' });
        const valid = await verifyOTP(phone, String(otp), dbGet, dbRun, {
          logger,
          requestId: req.id,
          provider: SMS_PROVIDER,
        });
        if (!valid)
          return res
            .status(401)
            .json({ success: false, message: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });
      }

      let driver = await driverRepo.findByPhone(phone);
      if (!driver) {
        driver = await driverRepo.create(phone);
      }

      // P6-06: approval_status هو مصدر الحقيقة الوحيد — لا JWT لأي حالة غير approved
      const approvalStatus = driver.approval_status || 'pending';

      if (approvalStatus === 'pending') {
        logger.info(`Driver login blocked (pending): ${phone.slice(0, 3)}***`);
        return res.status(403).json({
          success: false,
          status: 'pending',
          message: 'حسابك قيد المراجعة — سيتم إخطارك عند اعتماد حسابك.',
        });
      }

      if (approvalStatus === 'rejected') {
        logger.info(`Driver login blocked (rejected): ${phone.slice(0, 3)}***`);
        return res.status(403).json({
          success: false,
          status: 'rejected',
          reason: driver.rejection_reason || null,
          message: 'تم رفض طلب التسجيل.',
        });
      }

      if (approvalStatus === 'suspended') {
        logger.info(`Driver login blocked (suspended): ${phone.slice(0, 3)}***`);
        return res.status(403).json({
          success: false,
          status: 'suspended',
          reason: driver.suspended_reason || null,
          message: 'تم إيقاف حسابك.',
        });
      }

      // approved — التدفق الطبيعي فقط من هنا
      await driverRepo.setStatus(phone, 'offline');
      await driverRepo.setTaxiStatus(driver.id, 'offline');

      const jwtPayload = {
        phone,
        type: 'driver',
        name: driver.name,
        role: 'driver',
        driverId: driver.id,
      };

      const accessToken = generateJWT(jwtPayload);
      const refreshToken = await generateRefreshToken(jwtPayload, dbRun);

      dbRun('INSERT INTO login_logs (phone, type, ip) VALUES (?, ?, ?)', [
        phone,
        'driver',
        req.ip,
      ]).catch(() => {});

      logger.success(`Driver login: ${phone.slice(0, 3)}***`);
      res.json({ success: true, driver, token: accessToken, refreshToken });
    } catch (err) {
      logger.error('Driver login error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تجديد الـ Access Token =====
  // POST /auth/refresh
  // Rate-limited per IP — يمنع brute force حتى مع الـ hash
  router.post('/auth/refresh', loginLimit, async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({ success: false, message: 'refresh token مطلوب' });
      }

      const payload = await verifyRefreshToken(refreshToken, dbGet);
      if (!payload) {
        return res
          .status(401)
          .json({ success: false, message: 'refresh token غير صالح أو منتهي الصلاحية' });
      }

      // P6-06 SECURITY FIX: للسائقين — التحقق من approval_status قبل إصدار token جديد.
      // سائق معلَّق يمتلك refresh token صالح → يجب رفضه وإلغاء token فوراً.
      // بدون هذا الفحص، يمكن للسائق المعلَّق الحصول على access token جديد عبر /auth/refresh.
      if (payload.type === 'driver') {
        const driver = await driverRepo.findByPhone(payload.phone);
        if (!driver || driver.approval_status !== 'approved') {
          // إلغاء refresh token فوراً — يمنع إعادة المحاولة
          await revokeRefreshToken(refreshToken, dbRun);
          const status = driver?.approval_status || 'suspended';
          logger.security('DRIVER_REFRESH_BLOCKED', {
            phone: payload.phone.slice(0, 3) + '***',
            status,
          });
          return res.status(403).json({
            success: false,
            status,
            message:
              status === 'suspended'
                ? 'تم إيقاف حسابك — لا يمكن تجديد الجلسة.'
                : 'حسابك غير معتمد — لا يمكن تجديد الجلسة.',
          });
        }
      }

      // إصدار access token جديد
      const newAccessToken = generateJWT(payload);

      // تدوير الـ refresh token — يُبطل القديم ويُصدر جديداً
      await revokeRefreshToken(refreshToken, dbRun);
      const newRefreshToken = await generateRefreshToken(payload, dbRun);

      logger.info(`Token refreshed: ${String(payload.phone).slice(0, 3)}***`);
      res.json({ success: true, token: newAccessToken, refreshToken: newRefreshToken });
    } catch (err) {
      logger.error('Token refresh error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تسجيل الخروج =====
  // POST /logout — يُبطل access token (in-memory) + refresh token (DB) إذا أُرسل
  router.post('/logout', async (req, res) => {
    try {
      const token =
        req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
      const { refreshToken } = req.body || {};

      const payload = verifyJWT(token);
      if (payload) {
        revokeTokens(payload.phone);
        logger.info(`Logout + access token revoked: ${String(payload.phone).slice(0, 3)}***`);
      }

      if (refreshToken && typeof refreshToken === 'string') {
        await revokeRefreshToken(refreshToken, dbRun);
      }

      res.json({ success: true, message: 'تم تسجيل الخروج' });
    } catch {
      // logout لا يفشل أبداً من وجهة نظر المستخدم
      res.json({ success: true, message: 'تم تسجيل الخروج' });
    }
  });

  // ===== تسجيل الخروج من جميع الأجهزة =====
  // POST /auth/logout-all — يُبطل جميع الـ refresh tokens + access tokens للمستخدم الحالي
  router.post('/auth/logout-all', authenticate, async (req, res) => {
    try {
      const { phone } = req.user;
      revokeTokens(phone); // access tokens (in-memory)
      await revokeAllRefreshTokens(phone, dbRun); // refresh tokens (DB)
      logger.info(`Logout all devices: ${String(phone).slice(0, 3)}***`);
      res.json({ success: true, message: 'تم تسجيل الخروج من جميع الأجهزة' });
    } catch (err) {
      logger.error('Logout-all error:', { message: err.message });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== التحقق من الجلسة =====
  // GET /auth/verify — يُعيد الـ JWT payload كاملاً (للتوافق مع session_service.dart)
  // لا تعدّل هذا الـ endpoint — مُستهلَك من session_service.dart للتحقق من صلاحية الـ token
  router.get('/auth/verify', (req, res) => {
    const token =
      req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
    const session = getSession(token);
    if (!session) return res.status(401).json({ success: false, message: 'الجلسة منتهية' });
    res.json({ success: true, session });
  });

  // ===== P6-05D: التحقق من صلاحيات المشرف (Minimal Response) =====
  // GET /auth/is-admin — يعيد { success, isAdmin } فقط — لا JWT payload، لا PII
  // Data Minimization: Flutter تحتاج role فقط — لا phone، name، iat، exp
  // Least Privilege: لا تُكشف بيانات الجلسة لمستهلك يسأل سؤالاً ثنائياً
  router.get('/auth/is-admin', (req, res) => {
    const token =
      req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
    const payload = verifyJWT(token);
    if (!payload) {
      return res.status(401).json({ success: false, message: 'غير مصرح - سجّل دخولك أولاً' });
    }
    // نفس منطق authenticateAdmin: role OR phone whitelist
    const isAdmin = payload.role === 'admin' || ADMIN_PHONES.includes(payload.phone);
    res.json({ success: true, isAdmin });
  });

  return router;
};
