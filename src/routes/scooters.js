'use strict';

const express = require('express');

module.exports = function createScootersRouter(svc) {
  const router = express.Router();
  const {
    logger,
    authenticate,
    authenticateAdmin,
    getCache,
    setCache,
    clearCache,
    CACHE_TTL,
    scooterRepo,
    userRepo,
    walletRepo,
    notifRepo,
    validateCoords,
    dbRun, // لعمليات taxis في resetAll — سيُنقل لاحقاً
    dbTransaction,
  } = svc;

  // ===== قائمة السكوترات =====
  // Principle of Least Privilege: نُرسل فقط ما يحتاجه Flutter للخريطة والاختيار
  // المحذوف: current_user_phone (PII) | ride_start_time | total_rentals | created_at (internal)
  const sanitizeScooter = ({ id, name, scooter_code, lat, lng, battery, status }) => ({
    id,
    name,
    scooter_code,
    lat,
    lng,
    battery,
    status,
  });

  router.get('/scooters', async (req, res) => {
    try {
      const cached = getCache('scooters');
      if (cached) return res.json(cached);
      const data = await scooterRepo.findAll();
      const safe = data.map(sanitizeScooter); // filter قبل الـ cache — يمنع تسريب البيانات عبر الـ cache
      setCache('scooters', safe, CACHE_TTL.scooters);
      res.json(safe);
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.get('/scooters/:id', async (req, res) => {
    try {
      const s = await scooterRepo.findById(req.params.id);
      if (!s) return res.status(404).json({ success: false });
      res.json(sanitizeScooter(s));
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== فتح قفل السكوتر =====
  // الإصلاح: phone يُقرأ من JWT (req.user.phone) بدلاً من req.body.phone
  // المسار والاستجابة لم يتغيرا — Backward Compatible
  router.post('/scooter/unlock', authenticate, async (req, res) => {
    try {
      const { scooterId } = req.body;
      const phone = req.user.phone; // Single Source of Truth: JWT
      const scooter = await scooterRepo.findById(scooterId);
      const user = await userRepo.findByPhone(phone);

      if (!scooter) return res.status(404).json({ success: false, message: 'السكوتر غير موجود' });
      if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      if (scooter.status !== 'available')
        return res.status(400).json({ success: false, message: 'السكوتر غير متاح حالياً' });
      if (user.balance < 0.5)
        return res
          .status(400)
          .json({ success: false, message: 'رصيد غير كافٍ - الحد الأدنى 0.500 د.ك' });
      if (scooter.battery < 10)
        return res.status(400).json({ success: false, message: 'بطارية السكوتر منخفضة جداً' });

      const startTime = Date.now();
      // C-004: Atomic unlock — يمنع TOCTOU race condition
      // WHERE status='available' في الـ UPDATE يضمن أن شخصاً آخر لم يسبق الفتح
      const lockResult = await scooterRepo.setRiding(scooterId, phone, startTime);
      if (lockResult.changes === 0) {
        return res
          .status(409)
          .json({ success: false, message: 'السكوتر غير متاح — تم فتحه للتو من مستخدم آخر' });
      }
      clearCache('scooters');

      const rideResult = await scooterRepo.createRide(scooterId, phone, startTime);

      logger.info(`Scooter #${scooterId} unlocked by ${String(phone).slice(0, 3)}***`);

      await notifRepo.send(
        phone,
        '🛴 تم فتح قفل السكوتر',
        `استمتع برحلتك! السكوتر ${scooter.name} جاهز`,
        'scooter_unlocked'
      );

      res.json({
        success: true,
        message: 'تم فتح قفل السكوتر',
        scooter: { ...scooter, status: 'riding' },
        rideId: rideResult.lastID,
        startTime,
      });
    } catch (err) {
      logger.error('unlock error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في فتح القفل' });
    }
  });

  // إصلاح M11: /scooter/rent legacy — 410 Gone (redirect 307 بدون auth خطر)
  router.post('/scooter/rent', (req, res) => {
    return res.status(410).json({
      success: false,
      message: 'هذه النقطة معطّلة. استخدم POST /scooter/unlock',
      code: 'ENDPOINT_DEPRECATED',
    });
  });

  // ===== إنهاء رحلة السكوتر =====
  // الإصلاح: phone يُقرأ من JWT (req.user.phone) بدلاً من req.body.phone
  // الفحص current_user_phone !== phone الآن يقارن DB بـ JWT (موثوق) بدلاً من body
  router.post('/scooter/end-ride', authenticate, async (req, res) => {
    try {
      const { scooterId, endLat, endLng } = req.body;
      const phone = req.user.phone; // Single Source of Truth: JWT
      const scooter = await scooterRepo.findById(scooterId);

      if (!scooter) return res.status(404).json({ success: false, message: 'السكوتر غير موجود' });
      if (scooter.current_user_phone !== phone) {
        return res.status(403).json({ success: false, message: 'هذا ليس سكوترك' });
      }

      const endTime = Date.now();
      const startTime = scooter.ride_start_time || endTime;
      const durationMinutes = Math.max(1, Math.round((endTime - startTime) / 60000));
      const fare = Math.max(0.5, Math.round(durationMinutes * 0.05 * 1000) / 1000);
      const batteryUsed = Math.min(scooter.battery - 5, Math.round(durationMinutes * 0.5));
      const newBattery = Math.max(5, scooter.battery - batteryUsed);

      try {
        // C-1 fix: مُسلسَل عبر dbTransaction بدل BEGIN TRANSACTION الخام —
        // يمنع تصادم المعاملات عند إنهاء رحلتَي سكوتر متزامنتين. السلوك محفوظ.
        await dbTransaction(async () => {
          await scooterRepo.setAvailable(
            scooterId,
            newBattery,
            endLat,
            endLng,
            scooter.lat,
            scooter.lng
          );
          clearCache('scooters');

          await scooterRepo.endRideRecord(
            scooterId,
            phone,
            endTime,
            durationMinutes,
            fare,
            endLat,
            endLng
          );

          // Atomic deduct — prevents race condition if end-ride called concurrently
          const deductResult = await walletRepo.deductBalanceSafe(phone, fare);
          const newBalance = deductResult.balanceAfter ?? 0;
          if (deductResult.success) {
            const balanceBefore = newBalance + fare;
            await walletRepo.logTransaction(
              phone,
              'scooter_payment',
              fare,
              balanceBefore,
              newBalance,
              `أجرة سكوتر ${durationMinutes} دقيقة`
            );
          }
        });
        logger.success(`Scooter #${scooterId} ride ended: ${durationMinutes}min = ${fare} KD`);
      } catch (txErr) {
        logger.error('Scooter end-ride transaction failed:', txErr.message);
        return res.status(500).json({ success: false, message: 'خطأ في إنهاء الرحلة' });
      }

      const finalUser = await userRepo.findByPhone(phone);
      res.json({
        success: true,
        message: 'تم إنهاء الرحلة',
        duration: durationMinutes,
        fare,
        newBalance: finalUser ? finalUser.balance : 0, // backward compatible with Flutter
      });
    } catch (err) {
      logger.error('end-ride error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في إنهاء الرحلة' });
    }
  });

  // إرجاع السكوتر (القديم - للتوافق)
  // إصلاح M11: يُرسَل 410 Gone بدلاً من redirect بدون مصادقة
  // السبب: redirect 307 ينقل الطلب بدون Authorization header مما يُفشل authenticate()
  // في النهاية، ويُضيف confusing للـ Flutter logs بلا فائدة
  router.post('/scooter/return', (req, res) => {
    return res.status(410).json({
      success: false,
      message: 'هذه النقطة معطّلة. استخدم POST /scooter/end-ride',
      code: 'ENDPOINT_DEPRECATED',
    });
  });

  // ===== سجل استخدام السكوتر =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ params.phone لمنع IDOR
  router.get('/scooter/history/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const rides = await scooterRepo.getRideHistory(phone);
      res.json(rides);
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== حالة سكوتر المستخدم الحالي =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ params.phone لمنع IDOR
  router.get('/scooter/active/:phone', authenticate, async (req, res) => {
    try {
      const phone = req.user.phone;
      const scooter = await scooterRepo.findActiveByPhone(phone);
      if (!scooter) return res.json({ active: false });
      const now = Date.now();
      const startTime = scooter.ride_start_time || now;
      const durationMinutes = Math.round((now - startTime) / 60000);
      const currentFare = Math.max(0.5, Math.round(durationMinutes * 0.05 * 1000) / 1000);
      res.json({ active: true, scooter, durationMinutes, currentFare });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== إدارة السكوترات (Admin) =====
  // إصلاح M1: validateCoords على lat/lng قبل إدخالها في DB
  router.post('/admin/scooters', authenticateAdmin, async (req, res) => {
    try {
      const { name, scooter_code, lat, lng, battery } = req.body;
      if (lat != null || lng != null) {
        if (!validateCoords(lat, lng)) {
          return res.status(400).json({ success: false, message: 'إحداثيات غير صالحة' });
        }
      }
      const result = await scooterRepo.create(name, scooter_code, lat, lng, battery);
      res.json({ success: true, id: result.lastID });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.delete('/admin/scooters/:id', authenticateAdmin, async (req, res) => {
    try {
      await scooterRepo.delete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== Reset السكوترات (Admin) =====
  router.post('/scooters/reset', authenticateAdmin, async (req, res) => {
    try {
      await scooterRepo.resetAll();
      await dbRun("UPDATE taxis SET status = 'online'"); // taxis → TripRepository لاحقاً
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  return router;
};
