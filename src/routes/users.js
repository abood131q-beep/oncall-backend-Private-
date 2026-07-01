'use strict';

const express = require('express');

module.exports = function createUsersRouter(svc) {
  const router = express.Router();
  const { authenticate, userRepo, walletRepo, notifRepo, reportRepo } = svc;

  // ===== تحديث بيانات المستخدم =====
  router.post('/user/update', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const { name } = req.body;
      if (!phone) return res.status(400).json({ success: false });
      const user = await userRepo.updateName(phone, name);
      res.json({ success: true, user });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== الرصيد =====
  router.get('/balance/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const row = await walletRepo.getBalance(phone);
      if (!row) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      res.json({ success: true, balance: row.balance });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== /balance/add — معطّل (Task 7.7) =====
  // هذه النقطة كانت تضيف رصيداً مباشرة بدون بوابة دفع — Business Logic Flaw.
  // استبدالها بـ POST /wallet/charge (المحمية بـ PAYMENT_ENABLED).
  // تبقى مُسجَّلة لإعطاء Flutter استجابة 410 واضحة بدلاً من 404 مُبهم.
  router.post('/balance/add', authenticate, (req, res) => {
    return res.status(410).json({
      success: false,
      message: 'هذه النقطة معطّلة. استخدم POST /wallet/charge لشحن رصيدك.',
      code: 'ENDPOINT_DEPRECATED',
    });
  });

  // ===== سجل العمليات المالية =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ params.phone لمنع IDOR
  router.get('/transactions/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const transactions = await walletRepo.getTransactions(phone, 50);
      res.json(transactions);
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== الإشعارات =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ params.phone لمنع IDOR
  router.get('/notifications/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const notifications = await notifRepo.findByPhone(phone, 20);
      res.json(notifications);
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.put('/notifications/:phone/read', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      await notifRepo.markAllRead(phone);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== البلاغات (من المستخدم) =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ body.phone لمنع IDOR
  router.post('/report', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const { type, description, trip_id } = req.body;
      await reportRepo.create(phone, type || 'general', description, trip_id || null);
      res.json({ success: true, message: 'تم إرسال البلاغ' });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  return router;
};
