'use strict';

const express = require('express');

module.exports = function createDriversRouter(svc) {
  const router = express.Router();
  const { authenticate, authenticateDriver, formatTrip, logger, driverRepo, tripRepo } = svc;

  // ===== حالة السائق =====
  // الإصلاح: phone يُقرأ من JWT (req.user.phone) بدلاً من req.body.phone
  // المسار والاستجابة لم يتغيرا — Backward Compatible
  router.post('/driver/status', authenticateDriver, async (req, res) => {
    try {
      const { isOnline } = req.body;
      const phone = req.user.phone; // Single Source of Truth: JWT
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

      const trips = await tripRepo.findByDriver(driver.id, driver.name, 1000);

      const completed = trips.filter((t) => t.status === 'completed');
      const cancelled = trips.filter((t) => t.status === 'cancelled');
      const totalEarnings = completed.reduce((s, t) => s + (t.final_fare || 0), 0);

      const today = new Date().toDateString();
      const todayEarnings = completed
        .filter((t) => new Date(t.created_at).toDateString() === today)
        .reduce((s, t) => s + (t.final_fare || 0), 0);

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const weekEarnings = completed
        .filter((t) => new Date(t.created_at).getTime() > weekAgo)
        .reduce((s, t) => s + (t.final_fare || 0), 0);

      const totalMinutes = completed.reduce((s, t) => s + (t.duration_minutes || 0), 0);
      const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
      const acceptanceRate =
        trips.length > 0
          ? Math.round(
              (trips.filter((t) => t.status !== 'waiting_driver').length / trips.length) * 100
            )
          : 100;

      const rated = completed.filter((t) => t.rating);
      const avgRating =
        rated.length > 0
          ? Math.round((rated.reduce((s, t) => s + t.rating, 0) / rated.length) * 10) / 10
          : 5.0;

      res.json({
        success: true,
        stats: {
          totalTrips: trips.length,
          completedTrips: completed.length,
          cancelledTrips: cancelled.length,
          totalEarnings: Math.round(totalEarnings * 1000) / 1000,
          todayEarnings: Math.round(todayEarnings * 1000) / 1000,
          weekEarnings: Math.round(weekEarnings * 1000) / 1000,
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
