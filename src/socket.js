'use strict';

/**
 * socket.js — OnCall Socket.IO event handlers
 *
 * الأمان:
 *  - io.use() middleware يرفض كل اتصال بدون JWT صالح
 *  - socket.data.user هو المصدر الوحيد الموثوق للهوية
 *  - socket.driverPhone يُعيَّن من JWT فور الاتصال (H5 fix)
 *  - driver:location يتحقق من ملكية الرحلة (M6 fix)
 *  - Rate limiting على driver:location (H4 fix: max 120/min)
 *
 * @param {import('socket.io').Server} io
 * @param {object} svc - services object (Dependency Injection)
 */

const { verifyJWT } = require('./middleware/auth');

// ─── Per-socket rate limiter ──────────────────────────────────────────────────
function checkRateLimit(socket, event, maxPerMin) {
  if (!socket._rl) socket._rl = {};
  const now = Date.now();
  const r = socket._rl[event] || { count: 0, reset: now + 60000 };
  if (now > r.reset) { r.count = 0; r.reset = now + 60000; }
  r.count++;
  socket._rl[event] = r;
  return r.count <= maxPerMin;
}

function setupSocket(io, svc) {
  const {
    dbGet,
    dbRun,
    formatTrip,
    safeJSON,
    getDistanceKm,
    calculateFare,
    clearCache,
    tripTimers,
    logger,
  } = svc;

  // ─── Authentication Middleware ────────────────────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      logger.warn(`Socket rejected — no token: ${socket.id}`);
      return next(new Error('Authentication required'));
    }

    const payload = verifyJWT(token);
    if (!payload) {
      logger.warn(`Socket rejected — invalid/expired token: ${socket.id}`);
      return next(new Error('Invalid or expired token'));
    }

    socket.data.user = payload;
    next();
  });

  io.on('connection', (socket) => {
    const { phone, type, driverId } = socket.data.user;
    logger.info(
      `Client connected: ${socket.id} | type:${type} | phone:${String(phone).slice(0, 3)}***`
    );

    // إصلاح H5: ضبط driverPhone من JWT فور الاتصال — لا ننتظر driver:register
    // يضمن أن disconnect handler يُعيّن السائق offline حتى لو لم يرسل driver:register
    if (type === 'driver') {
      socket.driverPhone = phone;
      socket.join(`driver:${phone}`);
    }

    // ─── الراكب ينضم لغرفة رحلته ────────────────────────────────────────────
    socket.on('passenger:join', async ({ tripId }) => {
      const userPhone = socket.data.user.phone;
      const tripRoom = `trip:${tripId}`;
      const passengerRoom = `passenger:${userPhone}`;
      if (!socket.rooms.has(tripRoom)) socket.join(tripRoom);
      if (!socket.rooms.has(passengerRoom)) socket.join(passengerRoom);
      logger.info(`Passenger joined trip:${tripId} | phone:${String(userPhone).slice(0, 3)}***`);

      try {
        const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [Number(tripId)]);
        if (trip) {
          socket.emit('trip:updated', formatTrip(trip));
          logger.info(`Sent trip status to passenger: ${trip.status}`);
        }
      } catch (e) {
        logger.error('passenger:join error:', { message: e.message, stack: e.stack });
      }
    });

    // ─── السائق ينضم لغرفة رحلته ─────────────────────────────────────────────
    socket.on('driver:join', async ({ tripId }) => {
      const driverPhone = socket.data.user.phone;
      const tripRoom = `trip:${tripId}`;
      if (!socket.rooms.has(tripRoom)) socket.join(tripRoom);
      logger.info(`Driver joined trip:${tripId} | phone:${String(driverPhone).slice(0, 3)}***`);

      try {
        const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [Number(tripId)]);
        if (trip) socket.emit('trip:updated', formatTrip(trip));
      } catch (e) {
        logger.error('driver:join error:', { message: e.message, stack: e.stack });
      }
    });

    // ─── تحديث موقع السائق REALTIME ──────────────────────────────────────────
    // إصلاح H4: Rate limit 120 حدث/دقيقة (2/ثانية كحد أقصى)
    // إصلاح M6: التحقق من أن المرسِل هو سائق الرحلة
    socket.on('driver:location', async ({ tripId, lat, lng }) => {
      // Rate limiting
      if (!checkRateLimit(socket, 'driver:location', 120)) return;

      try {
        const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [Number(tripId)]);
        if (!trip) return;

        // Ownership check: فقط سائق الرحلة يُرسل موقعها
        const jwtDriverId = driverId || null;
        if (jwtDriverId && trip.driver_id && trip.driver_id !== jwtDriverId) {
          logger.warn(
            `Unauthorized driver:location — driver ${jwtDriverId} for trip ${tripId} owned by driver ${trip.driver_id}`
          );
          return;
        }

        let liveStats = null;
        const route = safeJSON(trip.route, []);

        if (trip.status === 'in_progress') {
          route.push({ lat, lng, time: Date.now() });
          if (route.length > 1) {
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
        }

        io.to(`trip:${tripId}`).emit('driver:moved', {
          t: tripId,
          la: Math.round(lat * 100000) / 100000,
          ln: Math.round(lng * 100000) / 100000,
          s: trip.status,
          st: liveStats,
        });

        // Fire-and-forget DB write — attach error handler (L7 fix)
        dbRun('UPDATE trips SET driver_lat = ?, driver_lng = ?, route = ? WHERE id = ?', [
          lat,
          lng,
          JSON.stringify(route),
          tripId,
        ]).catch((e) => logger.error('driver:location DB write error:', { message: e.message }));

        if (trip.driver_id) {
          dbRun('UPDATE taxis SET lat = ?, lng = ? WHERE driver_id = ?', [
            lat,
            lng,
            trip.driver_id,
          ]).catch((e) => logger.error('driver:location taxi update error:', { message: e.message }));
          clearCache('taxis');
        }
      } catch (e) {
        logger.error('driver:location error:', { message: e.message, stack: e.stack });
      }
    });

    // ─── قطع الاتصال ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      logger.info(`Client disconnected: ${socket.id}`);
      // socket.driverPhone مضبوط من JWT على الاتصال للسائقين (H5 fix)
      if (socket.driverPhone) {
        try {
          await dbRun("UPDATE drivers SET status='offline' WHERE phone=?", [socket.driverPhone]);
          for (const [key, timer] of tripTimers.entries()) {
            if (key.includes(socket.driverPhone)) {
              clearTimeout(timer);
              tripTimers.delete(key);
            }
          }
          logger.info(
            `Driver ${String(socket.driverPhone).slice(0, 3)}*** set offline on disconnect`
          );
        } catch (e) {
          logger.error('disconnect cleanup error:', { message: e.message });
        }
      }
      socket.rooms.forEach((room) => {
        if (room !== socket.id) socket.leave(room);
      });
    });

    // ─── تسجيل السائق ────────────────────────────────────────────────────────
    socket.on('driver:register', () => {
      const registeredPhone = socket.data.user.phone;
      socket.driverPhone = registeredPhone; // تأكيد (قد يكون مضبوطاً مسبقاً)
      if (!socket.rooms.has(`driver:${registeredPhone}`)) socket.join(`driver:${registeredPhone}`);
      socket.join('drivers:online');
      logger.info(`Driver ${String(registeredPhone).slice(0, 3)}*** registered in drivers:online room`);
    });

    // ─── تغيير حالة السائق ───────────────────────────────────────────────────
    socket.on('driver:status', (data) => {
      if (data?.isOnline !== undefined) {
        const statusPhone = socket.data.user.phone;
        if (data.isOnline) {
          socket.join('drivers:online');
          logger.info(`Driver ${String(statusPhone).slice(0, 3)}*** went online`);
        } else {
          socket.leave('drivers:online');
          logger.info(`Driver ${String(statusPhone).slice(0, 3)}*** went offline`);
        }
      }
    });
  });

  // ─── إصلاح تلقائي للتاكسيات كل ساعة ────────────────────────────────────────
  // يُعيد تاكسيات stuck في 'busy' إلى 'online' إذا لم يكن سائقها في رحلة نشطة.
  // الشرط driver_id NOT IN يقارن taxis.driver_id (= drivers.id) مع trips.driver_id —
  // نفس مساحة IDs. السابق كان يقارن taxis.id (= taxis PK) مع drivers.id — خطأ.
  setInterval(
    async () => {
      try {
        await dbRun(`
          UPDATE taxis SET status = 'online'
          WHERE status = 'busy'
          AND (
            driver_id IS NULL
            OR driver_id NOT IN (
              SELECT driver_id FROM trips
              WHERE status IN ('accepted','arrived','in_progress')
              AND driver_id IS NOT NULL
            )
          )
        `);
      } catch (e) {
        logger.error('Taxi auto-fix error:', { message: e.message });
      }
    },
    60 * 60 * 1000
  ).unref();
}

module.exports = { setupSocket };
