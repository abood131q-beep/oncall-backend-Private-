'use strict';

const express = require('express');

module.exports = function createDriversRouter(svc) {
  const router = express.Router();
  const { authenticateDriver, formatTrip, logger, driverRepo, tripRepo } = svc;

  // ===== حالة السائق =====
  // الإصلاح: phone يُقرأ من JWT (req.user.phone) بدلاً من req.body.phone
  // المسار والاستجابة لم يتغيرا — Backward Compatible
  router.post('/driver/status', authenticateDriver, async (req, res) => {
    try {
      const { isOnline } = req.body;
      const phone = req.user.phone; // Single Source of Truth: JWT

      // P6-06: السائق غير المعتمد لا يستطيع تغيير حالته إلى Online — خط دفاع ثالث
      if (isOnline) {
        const driver = await driverRepo.findByPhone(phone);
        if (!driver || driver.approval_status !== 'approved') {
          logger.warn(`Driver ${phone.slice(0, 3)}*** blocked status change (not approved)`);
          return res.status(403).json({
            success: false,
            status: driver?.approval_status || 'pending',
            message: 'حسابك لم يتم اعتماده — لا يمكنك الانتقال إلى حالة Online.',
          });
        }
      }

      const status = isOnline ? 'online' : 'offline';
      await driverRepo.setStatus(phone, status);
      const driver = await driverRepo.findByPhone(phone);
      if (driver) await driverRepo.setTaxiStatus(driver.id, status);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== بيانات السائق =====
  // الإصلاح: phone يُقرأ من JWT بدلاً من req.params.phone
  // المسار /driver/info/:phone محفوظ للتوافق مع Flutter — :phone يُتجاهل داخل الـ handler
  router.get('/driver/info/:phone', authenticateDriver, async (req, res) => {
    try {
      const phone = req.user.phone; // Single Source of Truth: JWT
      const driver = await driverRepo.findByPhone(phone);
      if (!driver) return res.status(404).json({ success: false });
      res.json({ success: true, driver });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== تحديث بيانات السائق =====
  // الإصلاح: phone يُقرأ من JWT بدلاً من req.body.phone
  // المسار والاستجابة لم يتغيرا — Backward Compatible
  router.post('/driver/update', authenticateDriver, async (req, res) => {
    try {
      const phone = req.user.phone; // Single Source of Truth: JWT
      const { name, car_name, plate } = req.body;
      const driver = await driverRepo.updateProfile(phone, name, car_name, plate);
      res.json({ success: true, driver });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== رحلات السائق =====
  // الإصلاح: phone يُقرأ من JWT بدلاً من req.params.phone
  // المسار /driver/trips/:phone محفوظ للتوافق مع Flutter — :phone يُتجاهل داخل الـ handler
  router.get('/driver/trips/:phone', authenticateDriver, async (req, res) => {
    try {
      const phone = req.user.phone; // Single Source of Truth: JWT
      const driver = await driverRepo.findByPhone(phone);
      if (!driver) return res.json([]);
      const trips = await tripRepo.findByDriver(driver.id, driver.name, 100);
      res.json(trips.map(formatTrip));
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== إحصائيات السائق =====
  // الإصلاح: phone يُقرأ من JWT بدلاً من req.params.phone
  // المسار /driver/stats/:phone محفوظ للتوافق مع Flutter — :phone يُتجاهل داخل الـ handler
  router.get('/driver/stats/:phone', authenticateDriver, async (req, res) => {
    try {
      const phone = req.user.phone; // Single Source of Truth: JWT
      const driver = await driverRepo.findByPhone(phone);
      if (!driver) return res.status(404).json({ success: false });

      // M-005: SQL aggregation بدلاً من تحميل 1000 رحلة — استعلام واحد O(1)
      const s = await tripRepo.getStats(driver.id);

      const totalMinutes = s.totalMinutes || 0;
      const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
      const acceptanceRate =
        s.totalTrips > 0 ? Math.round((s.respondedTrips / s.totalTrips) * 100) : 100;
      const avgRating = Math.round((s.avgRating || 5.0) * 10) / 10;

      res.json({
        success: true,
        stats: {
          totalTrips: s.totalTrips || 0,
          completedTrips: s.completedTrips || 0,
          cancelledTrips: s.cancelledTrips || 0,
          totalEarnings: Math.round((s.totalEarnings || 0) * 1000) / 1000,
          todayEarnings: Math.round((s.todayEarnings || 0) * 1000) / 1000,
          weekEarnings: Math.round((s.weekEarnings || 0) * 1000) / 1000,
          totalHours,
          totalMinutes,
          acceptanceRate,
          avgRating,
          driverName: driver.name,
          driverStatus: driver.status,
          carName: driver.car_name || '',
          plate: driver.plate || '',
        },
      });
    } catch (err) {
      logger.error('driver stats error:', err.message);
      res.status(500).json({ success: false });
    }
  });

  // ===== تقييمات السائق =====
  // الإصلاح: phone يُقرأ من JWT بدلاً من req.params.phone
  // المسار /driver/reviews/:phone محفوظ للتوافق مع Flutter — :phone يُتجاهل داخل الـ handler
  router.get('/driver/reviews/:phone', authenticateDriver, async (req, res) => {
    try {
      const phone = req.user.phone; // Single Source of Truth: JWT
      const driver = await driverRepo.findByPhone(phone);
      if (!driver) return res.status(404).json({ success: false });
      const reviews = await driverRepo.getReviews(driver.id);
      res.json({
        success: true,
        avgRating: driver.rating || 5.0,
        totalRatings: driver.total_ratings || 0,
        reviews,
      });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  return router;
};
