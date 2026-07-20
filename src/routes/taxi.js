'use strict';

const express = require('express');
const { createDriverMatcher } = require('../services/driverMatcher');
const { createPaymentService } = require('../services/payment');
const { getPlacesAutocomplete, getPlaceDetails } = require('../services/places');

module.exports = function createTaxiRouter(svc) {
  const router = express.Router();
  const {
    dbRun,
    dbTransaction,
    dbAll,
    logger,
    authenticate,
    authenticateDriver,
    authenticatePassenger,
    authenticateAdmin,
    io,
    tripTimers,
    getCache,
    setCache,
    CACHE_TTL,
    getDistanceKm,
    safeJSON,
    formatTrip,
    getFareBreakdown,
    calculateFare,
    validateCoords,
    driverRepo,
    tripRepo,
    notifRepo,
    notifService, // P6-02 — Push Notifications
  } = svc;

  // Helper: reset taxi status by driver FK (trip.driver_id = drivers.id, not taxis.id)
  const resetTaxiOnline = (driverId) => driverRepo.setTaxiStatus(driverId, 'online');

  // Authorization: هل يحق للمستخدم الوصول لهذه الرحلة؟
  const canAccessTrip = (user, trip) =>
    user.role === 'admin' ||
    user.phone === trip.user_phone ||
    (user.driverId != null && user.driverId === trip.driver_id);

  // ─── Driver Matcher (DriverMatcherService) ───────────────────────────────
  const { findNearestDriver, sendRequestToDriver } = createDriverMatcher(svc);

  // ─── Payment (PaymentService) ─────────────────────────────────────────────
  const { processPayment } = createPaymentService(svc);

  // ===== التاكسيات =====
  // متاح بدون مصادقة (ضروري لعرض الخريطة قبل الطلب)
  // الحقول المُعادة مُصفَّاة: driver_id محذوف (FK داخلي لا يلزم العميل)
  const sanitizeTaxi = ({ id, name, lat, lng, status }) => ({ id, name, lat, lng, status });

  router.get('/taxis', async (req, res) => {
    try {
      const cached = getCache('taxis');
      if (cached) return res.json(cached);
      const data = await dbAll('SELECT * FROM taxis');
      const safe = data.map(sanitizeTaxi);
      setCache('taxis', safe, CACHE_TTL.taxis);
      res.json(safe);
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== طلب تاكسي =====
  // الإصلاح H1: phone يُقرأ من JWT بدلاً من req.body.phone
  router.post('/taxi/request', authenticatePassenger, async (req, res) => {
    try {
      const { pickup, destination, pickupLat, pickupLng, destLat, destLng, payment_method } =
        req.body;
      const phone = req.user.phone; // Single Source of Truth: JWT — نتجاهل أي phone من العميل
      const validPaymentMethods = ['cash', 'wallet'];
      const paymentMethod = validPaymentMethods.includes(payment_method) ? payment_method : 'cash';
      if (!pickup || !destination) {
        return res.status(400).json({ success: false, message: 'بيانات الرحلة ناقصة' });
      }
      // إصلاح M1: التحقق من صحة الإحداثيات إذا أُرسلت
      if ((pickupLat || pickupLng) && !validateCoords(pickupLat, pickupLng)) {
        return res
          .status(400)
          .json({ success: false, message: 'إحداثيات نقطة الانطلاق غير صحيحة' });
      }
      if ((destLat || destLng) && !validateCoords(destLat, destLng)) {
        return res.status(400).json({ success: false, message: 'إحداثيات الوجهة غير صحيحة' });
      }

      let estimatedFare = 0.75;
      if (pickupLat && pickupLng && destLat && destLng) {
        const distKm = getDistanceKm(pickupLat, pickupLng, destLat, destLng);
        const estMin = Math.round(distKm * 3);
        estimatedFare = getFareBreakdown(distKm, estMin).total;
      }

      const result = await tripRepo.create(
        phone,
        pickup,
        destination,
        pickupLat,
        pickupLng,
        destLat,
        destLng,
        estimatedFare,
        paymentMethod
      );

      const tripId = result.lastID;
      const trip = await tripRepo.findById(tripId);
      const formatted = formatTrip(trip);

      res.json({ success: true, trip: formatted });

      const nearestDriver = await findNearestDriver(pickupLat, pickupLng);
      if (nearestDriver) {
        await sendRequestToDriver(tripId, nearestDriver);
        logger.info(
          `Nearest driver: ${nearestDriver.name} (${nearestDriver.distance?.toFixed(2)} km) → trip #${tripId}`
        );
      } else {
        logger.warn(`No drivers available for trip #${tripId}`);
        io.to(`trip:${tripId}`).emit('trip:updated', {
          ...formatted,
          status: 'no_driver',
          message: 'لا يوجد سائقون متاحون',
        });
      }
    } catch (err) {
      logger.error('taxi/request error:', err.message);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  });

  // ===== رفض الرحلة =====
  // الإصلاح M1: driver_phone يُقرأ من JWT بدلاً من req.body.driver_phone
  router.post('/taxi/trips/:id/reject', authenticateDriver, async (req, res) => {
    try {
      const tripId = Number(req.params.id);
      const driver_phone = req.user.phone; // Single Source of Truth: JWT — نتجاهل driver_phone من العميل

      const trip = await tripRepo.findById(tripId);
      if (!trip || trip.status !== 'waiting_driver')
        return res.status(400).json({ success: false });

      const driver = await driverRepo.findByPhone(driver_phone);
      if (!driver) return res.status(403).json({ success: false });

      const timer = tripTimers.get(`${tripId}`);
      if (timer) {
        clearTimeout(timer);
        tripTimers.delete(`${tripId}`);
      }

      const rejected = safeJSON(trip.rejected_drivers, []);
      rejected.push(driver.id);
      await tripRepo.setRejectedDrivers(tripId, rejected);
      logger.info(`Driver ${driver.name} rejected trip #${tripId}`);

      const nextDriver = await findNearestDriver(trip.pickup_lat, trip.pickup_lng, rejected);
      if (nextDriver) {
        await sendRequestToDriver(tripId, nextDriver);
        res.json({ success: true, message: 'جاري إرسال الطلب لسائق آخر' });
      } else {
        await tripRepo.setStatus(tripId, 'no_driver');
        io.to(`trip:${tripId}`).emit('trip:updated', {
          ...formatTrip(trip),
          status: 'no_driver',
          message: 'لا يوجد سائقون متاحون',
        });
        res.json({ success: true, message: 'لا يوجد سائقون متاحون' });
      }
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== جميع الرحلات =====
  // إصلاح TD-001: driver_phone من query params محذوف — IDOR يتيح لأي مستخدم رؤية رحلات أي سائق.
  // الآن: JWT يُحدِّد الهوية — فقط السائق يصل لهذا الـ endpoint.
  router.get('/taxi/trips', authenticateDriver, async (req, res) => {
    try {
      const driver = await driverRepo.findByPhone(req.user.phone); // Single Source of Truth: JWT
      let trips;
      if (driver) {
        trips = await tripRepo.findForDriver(driver.id, driver.name, 50);
      } else {
        trips = await tripRepo.findAll(100);
      }
      res.json(trips.map(formatTrip));
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  router.get('/taxi/requests', authenticateDriver, async (req, res) => {
    try {
      const trips = await tripRepo.findWaiting(100);
      res.json(trips.map(formatTrip));
    } catch (err) {
      res.status(500).json([]);
    }
  });

  // ===== رحلات الراكب =====
  // ملاحظة أمنية: req.user.phone من JWT — لا نثق بـ params.phone لمنع IDOR
  router.get('/taxi/trips/passenger/:phone', authenticatePassenger, async (req, res) => {
    try {
      const phone = req.user.phone;
      const trips = await tripRepo.findByPassenger(phone);
      res.json(trips.map(formatTrip));
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== تغيير حالة الرحلة =====
  // الإصلاح H2: driver_phone يُقرأ من JWT عند accepted
  // القاعدة: ممنوع أن تصبح أي رحلة accepted بدون driver صالح مرتبط بها
  router.put('/taxi/trips/:id/status', authenticate, async (req, res) => {
    try {
      const tripId = Number(req.params.id);
      const { status } = req.body; // driver_phone محذوف — يُستخرج من JWT عند الحاجة
      const validStatuses = [
        'waiting_driver',
        'accepted',
        'arrived',
        'in_progress',
        'completed',
        'cancelled',
      ];
      if (!validStatuses.includes(status))
        return res.status(400).json({ success: false, message: 'الحالة غير صحيحة' });

      // Authorization: الحالات التي تخص السائق فقط
      const DRIVER_ONLY_STATUSES = ['accepted', 'arrived', 'in_progress', 'completed'];
      if (DRIVER_ONLY_STATUSES.includes(status) && req.user.type !== 'driver') {
        return res.status(403).json({ success: false, message: 'هذا الإجراء مخصص للسائقين فقط' });
      }

      const trip = await tripRepo.findById(tripId);
      if (!trip) return res.status(404).json({ success: false, message: 'الرحلة غير موجودة' });

      if (status === 'accepted') {
        if (trip.status !== 'waiting_driver') {
          return res
            .status(400)
            .json({ success: false, message: 'تم قبول هذه الرحلة من سائق آخر' });
        }
        // Single Source of Truth: JWT — نتجاهل driver_phone من العميل
        const driver = await driverRepo.findByPhone(req.user.phone);
        if (!driver) {
          return res.status(403).json({ success: false, message: 'السائق غير موجود في النظام' });
        }
        const taxi = await driverRepo.findTaxi(driver.id);
        // C-005: Atomic acceptance — WHERE status='waiting_driver' في الـ UPDATE
        // يمنع TOCTOU race condition عندما يقبل سائقان في نفس اللحظة
        const acceptResult = await tripRepo.acceptByDriver(
          tripId,
          driver.id,
          driver.name,
          taxi ? taxi.lat : null,
          taxi ? taxi.lng : null
        );
        if (acceptResult.changes === 0) {
          return res
            .status(400)
            .json({ success: false, message: 'تم قبول هذه الرحلة من سائق آخر' });
        }
        if (taxi) await dbRun("UPDATE taxis SET status = 'busy' WHERE id = ?", [taxi.id]);
        const acceptTimer = tripTimers.get(`${tripId}`);
        if (acceptTimer) {
          clearTimeout(acceptTimer);
          tripTimers.delete(`${tripId}`);
        }
      } else if (status === 'in_progress') {
        // Ownership: فقط سائق الرحلة يستطيع بدء الرحلة
        const inProgressDriver = await driverRepo.findByPhone(req.user.phone);
        if (!inProgressDriver || trip.driver_id !== inProgressDriver.id) {
          return res
            .status(403)
            .json({ success: false, message: 'فقط سائق الرحلة يستطيع بدء الرحلة' });
        }
        await tripRepo.startTrip(tripId, Date.now());
      } else if (status === 'completed') {
        // Ownership: فقط سائق الرحلة يستطيع إنهاء الرحلة (ويُفعّل الدفع)
        const completedDriver = await driverRepo.findByPhone(req.user.phone);
        if (!completedDriver || trip.driver_id !== completedDriver.id) {
          return res
            .status(403)
            .json({ success: false, message: 'فقط سائق الرحلة يستطيع إنهاء الرحلة' });
        }
        const route = safeJSON(trip.route, []);
        let totalDistKm = 0;
        for (let i = 1; i < route.length; i++) {
          totalDistKm += getDistanceKm(
            route[i - 1].lat,
            route[i - 1].lng,
            route[i].lat,
            route[i].lng
          );
        }
        if (totalDistKm < 0.1 && trip.pickup_lat && trip.dest_lat) {
          totalDistKm = getDistanceKm(
            trip.pickup_lat,
            trip.pickup_lng,
            trip.dest_lat,
            trip.dest_lng
          );
        }
        let durationMinutes = 0;
        if (trip.start_time) {
          const diffMs = Date.now() - Number(trip.start_time);
          if (diffMs > 0 && diffMs < 86400000)
            durationMinutes = Math.max(1, Math.round(diffMs / 60000));
        }
        const finalFare =
          totalDistKm > 0.1
            ? calculateFare(totalDistKm, durationMinutes)
            : durationMinutes > 0
              ? Math.round((1.0 + durationMinutes * 0.05) * 1000) / 1000
              : trip.estimated_fare || 1.0;

        await tripRepo.completeTrip(tripId, finalFare, totalDistKm, durationMinutes);

        if (trip.user_phone) {
          try {
            // C-1 fix: مُسلسَل عبر dbTransaction (BEGIN IMMEDIATE + طابور داخلي)
            // بدل BEGIN TRANSACTION الخام — يمنع تصادم "cannot start a transaction
            // within a transaction" عند إكمال رحلتين متزامنتين. السلوك محفوظ.
            await dbTransaction(async () => {
              const paymentMethod = trip.payment_method || 'cash';
              const payResult = await processPayment(
                tripId,
                trip.user_phone,
                finalFare,
                paymentMethod
              );
              logger.success(
                `Payment #${tripId}: ${paymentMethod} = ${finalFare} KD - ${payResult.success ? 'OK' : 'FAILED'}`
              );
              await dbRun('UPDATE trips SET payment_status = ? WHERE id = ?', [
                payResult.success ? 'completed' : 'failed',
                tripId,
              ]);
              await notifRepo.sendForTrip(
                trip.user_phone,
                '🏁 وصلت بسلامة',
                `الأجرة: ${finalFare.toFixed(3)} د.ك (${paymentMethod === 'wallet' ? 'محفظة' : 'نقداً'})`,
                'trip_completed',
                tripId
              );
            });
          } catch (payErr) {
            logger.error('Payment transaction failed:', payErr.message);
          }
        }
        if (trip.driver_id) await resetTaxiOnline(trip.driver_id);
      } else if (status === 'cancelled') {
        // State machine: منع إلغاء رحلة مكتملة أو ملغاة أو بلا سائق
        const CANCELLABLE_STATUSES = ['waiting_driver', 'accepted', 'arrived', 'in_progress'];
        if (!CANCELLABLE_STATUSES.includes(trip.status)) {
          return res.status(400).json({
            success: false,
            message: 'لا يمكن إلغاء هذه الرحلة في حالتها الحالية',
          });
        }
        // Ownership: الراكب الأصلي أو سائق الرحلة يستطيع الإلغاء
        const isPassenger = req.user.phone === trip.user_phone;
        const cancelDriver = isPassenger ? null : await driverRepo.findByPhone(req.user.phone);
        const isAssignedDriver = cancelDriver !== null && trip.driver_id === cancelDriver.id;
        if (!isPassenger && !isAssignedDriver) {
          return res
            .status(403)
            .json({ success: false, message: 'فقط الراكب أو سائق الرحلة يستطيع الإلغاء' });
        }
        await tripRepo.setStatus(tripId, 'cancelled');
        if (trip.driver_id) await resetTaxiOnline(trip.driver_id);
      } else {
        // arrived وغيرها: فقط سائق الرحلة
        const miscDriver = await driverRepo.findByPhone(req.user.phone);
        if (!miscDriver || trip.driver_id !== miscDriver.id) {
          return res
            .status(403)
            .json({ success: false, message: 'غير مصرح لك بتغيير حالة هذه الرحلة' });
        }
        await tripRepo.setStatus(tripId, status);
      }

      const updated = await tripRepo.findById(tripId);
      const formatted = formatTrip(updated);

      const room = `trip:${tripId}`;
      const roomClients = io.sockets.adapter.rooms.get(room);
      logger.info(
        `Emitting trip:updated → room ${room} (${roomClients ? roomClients.size : 0} clients) status:${status}`
      );
      io.to(room).emit('trip:updated', formatted);

      if (status === 'accepted' && updated.user_phone) {
        logger.info(
          `Emitting trip:accepted → passenger:${String(updated.user_phone).slice(0, 3)}***`
        );
        io.to(`passenger:${updated.user_phone}`).emit('trip:accepted', formatted);
        io.to(room).emit('trip:accepted', formatted);
      }

      // P6-02: Push Notification — أرسل فقط إذا كان الراكب غير متصل بالـ Socket
      if (updated.user_phone && notifService?.isConfigured) {
        const passengerRoom = `passenger:${updated.user_phone}`;
        const passengerClients = io.sockets.adapter.rooms.get(passengerRoom);
        const passengerOnline = passengerClients && passengerClients.size > 0;

        if (!passengerOnline) {
          let pushTitle = null;
          let pushBody = null;

          if (status === 'accepted') {
            pushTitle = '✅ تم قبول رحلتك';
            pushBody = `السائق ${updated.driver_name || ''} في الطريق إليك`;
          } else if (status === 'arrived') {
            pushTitle = '📍 السائق وصل';
            pushBody = 'السائق في انتظارك — انزل الآن';
          } else if (status === 'completed') {
            const fare = updated.final_fare != null ? Number(updated.final_fare).toFixed(3) : '—';
            pushTitle = '🏁 وصلت بسلامة';
            pushBody = `الأجرة: ${fare} د.ك — شكراً لاستخدام On Call`;
          } else if (status === 'cancelled') {
            pushTitle = '❌ تم إلغاء الرحلة';
            pushBody = 'يمكنك طلب سيارة جديدة في أي وقت';
          }

          if (pushTitle) {
            notifService
              .send(updated.user_phone, pushTitle, pushBody, { tripId: String(tripId), status })
              .catch((e) => logger.error('FCM passenger push error:', { message: e.message }));
          }
        }
      }

      res.json({ success: true, trip: formatted });
    } catch (err) {
      logger.error('trip status update error:', err.message);
      res.status(500).json({ success: false });
    }
  });

  // ===== تقييم الراكب للسائق =====
  router.post('/taxi/trips/:id/rate', authenticatePassenger, async (req, res) => {
    try {
      const tripId = Number(req.params.id);
      const { rating, comment } = req.body;
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'التقييم يجب أن يكون بين 1 و 5' });
      }
      const trip = await tripRepo.findById(tripId);
      if (!trip) return res.status(404).json({ success: false });

      // Ownership Validation: فقط راكب الرحلة يستطيع تقييم السائق
      if (req.user.phone !== trip.user_phone) {
        return res
          .status(403)
          .json({ success: false, message: 'يمكن للراكب الأصلي فقط تقييم السائق' });
      }

      // منع التقييم المكرر
      if (trip.rating !== null && trip.rating !== undefined) {
        return res.status(409).json({ success: false, message: 'لقد قيّمت هذه الرحلة مسبقاً' });
      }

      if (trip.status !== 'completed') {
        return res.status(400).json({ success: false, message: 'يمكن تقييم الرحلات المكتملة فقط' });
      }

      await tripRepo.rateByPassenger(tripId, rating, comment);

      if (trip.driver_id) {
        const driverTrips = await tripRepo.getRatingsByDriver(trip.driver_id);
        if (driverTrips.length > 0) {
          const avg = driverTrips.reduce((s, t) => s + t.rating, 0) / driverTrips.length;
          await driverRepo.updateRating(
            trip.driver_id,
            Math.round(avg * 10) / 10,
            driverTrips.length
          );
        }
      }

      // إصلاح H8: استخدام driver_id (فريد) بدلاً من driver_name (غير فريد) لجلب بيانات السائق
      if (trip.driver_id) {
        const driver = await driverRepo.findById(trip.driver_id);
        if (driver) {
          await notifRepo.sendForTrip(
            driver.phone,
            `${'⭐'.repeat(rating)} تقييم جديد`,
            `حصلت على ${rating}/5 نجوم${comment ? ': ' + comment : ''}`,
            'rating_received',
            tripId
          );
        }
      }

      res.json({ success: true, message: 'شكراً على تقييمك! ⭐' });
    } catch (err) {
      logger.error('rate error:', err.message);
      res.status(500).json({ success: false });
    }
  });

  // ===== تقييم السائق للراكب =====
  router.post('/taxi/trips/:id/rate-passenger', authenticateDriver, async (req, res) => {
    try {
      const tripId = Number(req.params.id);
      const { rating, comment } = req.body;
      if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false });

      const trip = await tripRepo.findById(tripId);
      if (!trip) return res.status(404).json({ success: false });

      // Ownership Validation: فقط سائق الرحلة يستطيع تقييم الراكب
      const ratingDriver = await driverRepo.findByPhone(req.user.phone);
      if (!ratingDriver || trip.driver_id !== ratingDriver.id) {
        return res
          .status(403)
          .json({ success: false, message: 'يمكن للسائق الأصلي فقط تقييم الراكب' });
      }

      // منع التقييم المكرر
      if (trip.driver_rating !== null && trip.driver_rating !== undefined) {
        return res.status(409).json({ success: false, message: 'لقد قيّمت هذا الراكب مسبقاً' });
      }

      if (trip.status !== 'completed') {
        return res.status(400).json({ success: false, message: 'يمكن تقييم الرحلات المكتملة فقط' });
      }

      await tripRepo.rateByDriver(tripId, rating, comment);

      if (trip.user_phone) {
        await notifRepo.sendForTrip(
          trip.user_phone,
          `${'⭐'.repeat(rating)} تقييمك من السائق`,
          `السائق قيّمك ${rating}/5 نجوم${comment ? ': ' + comment : ''}`,
          'rating_received',
          tripId
        );
      }
      res.json({ success: true, message: 'تم تسجيل التقييم' });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== تحديث موقع السائق (HTTP fallback) =====
  router.post('/taxi/update-location', authenticateDriver, async (req, res) => {
    try {
      const { tripId, lat, lng } = req.body;
      const trip = await tripRepo.findById(Number(tripId));
      if (!trip) return res.status(404).json({ success: false });

      // Ownership Validation (Task 7.8): فقط سائق الرحلة يستطيع تحديث الموقع (HTTP fallback)
      const locationDriver = await driverRepo.findByPhone(req.user.phone);
      if (!locationDriver || trip.driver_id !== locationDriver.id) {
        return res
          .status(403)
          .json({ success: false, message: 'غير مصرح لك بتحديث موقع هذه الرحلة' });
      }

      const route = safeJSON(trip.route, []);
      if (trip.status === 'in_progress') route.push({ lat, lng, time: Date.now() });

      await tripRepo.updateLocation(tripId, lat, lng, route);
      if (trip.driver_id)
        await dbRun('UPDATE taxis SET lat = ?, lng = ? WHERE driver_id = ?', [
          lat,
          lng,
          trip.driver_id,
        ]);

      let liveStats = null;
      if (trip.status === 'in_progress' && route.length > 1) {
        let totalDist = 0;
        for (let i = 1; i < route.length; i++) {
          totalDist += getDistanceKm(
            route[i - 1].lat,
            route[i - 1].lng,
            route[i].lat,
            route[i].lng
          );
        }
        let durationMin = 0;
        if (trip.start_time) {
          const diffMs = Date.now() - Number(trip.start_time);
          if (diffMs > 0 && diffMs < 86400000) durationMin = Math.round(diffMs / 60000);
        }
        liveStats = {
          distanceKm: Math.round(totalDist * 1000) / 1000,
          durationMinutes: durationMin,
          currentFare: calculateFare(totalDist, durationMin),
        };
      }
      io.to(`trip:${tripId}`).emit('driver:moved', {
        tripId,
        lat,
        lng,
        liveStats,
        status: trip.status,
      });
      res.json({ success: true, liveStats });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== موقع السائق =====
  router.get('/taxi/trips/:id/location', authenticate, async (req, res) => {
    try {
      const trip = await tripRepo.findById(Number(req.params.id));
      if (!trip) return res.status(404).json({ success: false });
      if (!canAccessTrip(req.user, trip))
        return res.status(403).json({ success: false, message: 'غير مصرح' });

      const route = safeJSON(trip.route, []);
      let distanceKm = 0;
      for (let i = 1; i < route.length; i++) {
        distanceKm += getDistanceKm(route[i - 1].lat, route[i - 1].lng, route[i].lat, route[i].lng);
      }
      let durationMinutes = 0;
      if (trip.start_time) {
        const diffMs = Date.now() - Number(trip.start_time);
        if (diffMs > 0 && diffMs < 86400000) durationMinutes = Math.round(diffMs / 60000);
      }
      res.json({
        success: true,
        driverLat: trip.driver_lat,
        driverLng: trip.driver_lng,
        driverName: trip.driver_name,
        pickupLat: trip.pickup_lat,
        pickupLng: trip.pickup_lng,
        destLat: trip.dest_lat,
        destLng: trip.dest_lng,
        status: trip.status,
        route,
        estimatedFare: trip.estimated_fare,
        finalFare: trip.final_fare,
        liveStats:
          trip.status === 'in_progress'
            ? {
                distanceKm: Math.round(distanceKm * 1000) / 1000,
                durationMinutes,
                currentFare: calculateFare(distanceKm, durationMinutes),
              }
            : null,
      });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== رحلة واحدة =====
  router.get('/taxi/trips/:id', authenticate, async (req, res) => {
    try {
      const trip = await tripRepo.findById(Number(req.params.id));
      if (!trip) return res.status(404).json({ success: false });
      if (!canAccessTrip(req.user, trip))
        return res.status(403).json({ success: false, message: 'غير مصرح' });
      res.json({ success: true, trip: formatTrip(trip) });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  // ===== Google Places Proxy (PlacesService) =====
  // Authentication مطلوب لمنع استهلاك GOOGLE_MAPS_API_KEY بشكل غير مصرح به
  router.get('/places/autocomplete', authenticate, async (req, res) => {
    const { input, lat, lng } = req.query;
    res.json(await getPlacesAutocomplete(input, lat, lng));
  });

  router.get('/places/details', authenticate, async (req, res) => {
    res.json(await getPlaceDetails(req.query.place_id));
  });

  // ===== حذف جميع الرحلات (Admin) =====
  router.delete('/taxi/trips', authenticateAdmin, async (req, res) => {
    try {
      await tripRepo.deleteAll();
      await dbRun("UPDATE taxis SET status = 'online'"); // taxis → TaxiRepository لاحقاً
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  });

  return router;
};
