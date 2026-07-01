'use strict';

const express = require('express');

module.exports = function createAuthRouter(svc) {
  const router = express.Router();
  const {
    logger,
    ADMIN_PHONES,
    generateJWT,
    verifyJWT,
    getSession,
    revokeTokens,
    validatePhone,
    loginLimit,
    phoneLoginLimit,
    userRepo,
    driverRepo,
  } = svc;

  // ===== تسجيل دخول الراكب =====
  router.post('/login', loginLimit, phoneLoginLimit, async (req, res) => {
    try {
      const { phone, name } = req.body;
      if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
      // إصلاح M2: التحقق من صيغة رقم الهاتف
      if (!validatePhone(phone))
        return res.status(400).json({ success: false, message: 'رقم الهاتف غير صحيح' });
      let user = await userRepo.findByPhone(phone);
      if (!user) {
        user = await userRepo.create(phone, name);
      }
      if (user.is_active === 0) {
        return res.status(403).json({ success: false, message: 'الحساب موقوف — تواصل مع الدعم' });
      }
      const isAdmin = ADMIN_PHONES.includes(phone);
      const jwtToken = generateJWT({
        phone,
        type: 'passenger',
        name: user.name,
        role: isAdmin ? 'admin' : 'passenger',
      });
      logger.success(`Passenger login: ${phone.slice(0, 3)}***`);
      res.json({ success: true, user, token: jwtToken });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تسجيل دخول السائق =====
  router.post('/driver/login', loginLimit, phoneLoginLimit, async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
      // إصلاح M2: التحقق من صيغة رقم الهاتف
      if (!validatePhone(phone))
        return res.status(400).json({ success: false, message: 'رقم الهاتف غير صحيح' });
      let driver = await driverRepo.findByPhone(phone);
      if (!driver) {
        driver = await driverRepo.create(phone);
      }
      if (driver.is_active === 0) {
        return res
          .status(403)
          .json({ success: false, message: 'حساب السائق موقوف — تواصل مع الدعم' });
      }
      await driverRepo.setStatus(phone, 'offline');
      await driverRepo.setTaxiStatus(driver.id, 'offline');
      const jwtToken = generateJWT({
        phone,
        type: 'driver',
        name: driver.name,
        role: 'driver',
        driverId: driver.id,
      });
      logger.success(`Driver login: ${phone.slice(0, 3)}***`);
      res.json({ success: true, driver, token: jwtToken });
    } catch (err) {
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== تسجيل الخروج =====
  router.post('/logout', (req, res) => {
    const token =
      req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
    const payload = verifyJWT(token);
    if (payload) {
      revokeTokens(payload.phone); // H3 fix: invalidate all tokens for this user immediately
      logger.info(`Logout + token revoked: ${String(payload.phone).slice(0, 3)}***`);
    }
    res.json({ success: true, message: 'تم تسجيل الخروج' });
  });

  // ===== التحقق من الجلسة =====
  router.get('/auth/verify', (req, res) => {
    const token =
      req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
    const session = getSession(token);
    if (!session) return res.status(401).json({ success: false, message: 'الجلسة منتهية' });
    res.json({ success: true, session });
  });

  return router;
};
