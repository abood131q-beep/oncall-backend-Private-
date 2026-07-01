'use strict';

const express = require('express');

// ─── Payment Gateway Feature Flag (Task 7.7) ────────────────────────────────
// يُقرأ مرة واحدة عند بدء التشغيل — لا overhead في كل request.
// في بيئة التطوير: PAYMENT_ENABLED غير مُعيَّن أو false → يُرفض /wallet/charge.
// عند ربط بوابة دفع حقيقية (K-Net / Visa / Apple Pay):
//   1. أضف منطق الـ gateway في handler.
//   2. اضبط PAYMENT_ENABLED=true في .env.
// المسار المستقبلي: payment intent → webhook → credit wallet (لا تضيف مباشرة).
const PAYMENT_ENABLED = process.env.PAYMENT_ENABLED === 'true';

const PAYMENT_METHODS = {
  cash: { id: 'cash', name: 'نقداً', icon: '💵', available: true },
  wallet: { id: 'wallet', name: 'المحفظة', icon: '👛', available: true },
  knet: { id: 'knet', name: 'كي نت', icon: '💳', available: false, note: 'قريباً' },
  visa: { id: 'visa', name: 'فيزا/ماستر', icon: '💳', available: false, note: 'قريباً' },
  apple_pay: { id: 'apple_pay', name: 'Apple Pay', icon: '🍎', available: false, note: 'قريباً' },
};

module.exports = function createPaymentRouter(svc) {
  const router = express.Router();
  const {
    authenticate,
    getFareBreakdown,
    FARE_CONFIG,
    getPriceMultiplier,
    getDistanceKm,
    userRepo,
    walletRepo,
    notifRepo,
  } = svc;

  // ===== طرق الدفع =====
  router.get('/payment/methods', (req, res) => {
    res.json({ success: true, methods: Object.values(PAYMENT_METHODS) });
  });

  // ===== شحن المحفظة =====
  // مقيَّد بـ PAYMENT_ENABLED (Task 7.7):
  //   false (dev) → 503 — لا بوابة دفع حقيقية مُهيَّأة.
  //   true  (prod) → يُنفَّذ المنطق الحالي كـ placeholder حتى ربط gateway فعلي.
  router.post('/wallet/charge', authenticate, async (req, res) => {
    const { amount, method } = req.body;
    const MAX_CHARGE = 500;
    if (!amount || Number(amount) <= 0 || Number(amount) > MAX_CHARGE)
      return res.status(400).json({
        success: false,
        message: `المبلغ يجب أن يكون بين 0.001 و ${MAX_CHARGE} د.ك`,
      });

    if (!PAYMENT_ENABLED) {
      return res.status(503).json({
        success: false,
        message: 'خدمة الدفع غير متاحة حالياً — بوابة الدفع غير مُهيَّأة في بيئة التطوير.',
        code: 'PAYMENT_GATEWAY_UNAVAILABLE',
      });
    }

    try {
      const phone = req.user.phone;
      const user = await userRepo.findByPhone(phone);
      if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

      const balanceBefore = user.balance;
      await walletRepo.addBalance(phone, amount);
      const after = await walletRepo.getBalance(phone);
      const balanceAfter = after ? after.balance : balanceBefore + Number(amount);

      await walletRepo.logTransaction(
        phone,
        'deposit',
        Number(amount),
        balanceBefore,
        balanceAfter,
        `شحن رصيد عبر ${method || 'غير محدد'}`,
        null,
        'completed'
      );

      await notifRepo.send(
        phone,
        '💰 تم شحن رصيدك',
        `تمت إضافة ${amount} د.ك - رصيدك الحالي: ${balanceAfter.toFixed(3)} د.ك`,
        'wallet_charge'
      );

      res.json({ success: true, balance: balanceAfter, message: `تم إضافة ${amount} د.ك` });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== سجل المدفوعات =====
  router.get('/wallet/transactions/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const transactions = await walletRepo.getTransactions(phone, 50);
      const row = await walletRepo.getBalance(phone);
      res.json({ success: true, balance: row?.balance || 0, transactions });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== رصيد المحفظة =====
  router.get('/wallet/balance/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const row = await walletRepo.getBalance(phone);
      if (!row) return res.status(404).json({ success: false });
      res.json({ success: true, balance: row.balance });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== تقدير الأجرة =====
  router.post('/fare/estimate', (req, res) => {
    try {
      const { pickupLat, pickupLng, destLat, destLng } = req.body;
      if (!pickupLat || !destLat) return res.status(400).json({ success: false });

      const distanceKm = getDistanceKm(pickupLat, pickupLng, destLat, destLng);
      const estimatedMinutes = Math.round(distanceKm * 3);
      const breakdown = getFareBreakdown(distanceKm, estimatedMinutes);

      res.json({
        success: true,
        distanceKm: Math.round(distanceKm * 100) / 100,
        estimatedMinutes,
        ...breakdown,
        config: {
          baseFare: FARE_CONFIG.baseFare,
          perKm: FARE_CONFIG.perKm,
          perMinute: FARE_CONFIG.perMinute,
          minimumFare: FARE_CONFIG.minimumFare,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== إعدادات الأجرة =====
  router.get('/fare/config', (req, res) => {
    const { multiplier, label } = getPriceMultiplier();
    res.json({
      ...FARE_CONFIG,
      currentMultiplier: multiplier,
      currentPriceType: label,
      isPeakHour: multiplier > 1.0,
    });
  });

  return router;
};
