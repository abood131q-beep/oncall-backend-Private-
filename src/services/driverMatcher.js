'use strict';

/**
 * DriverMatcherService — البحث الذكي عن السائق الأقرب
 *
 * المسؤوليات:
 *  - البحث عن السائق المتاح الأقرب جغرافياً للراكب
 *  - إرسال طلب الرحلة للسائق عبر Socket.IO
 *  - إدارة مؤقت 30 ثانية لكل سائق
 *  - تمرير الطلب للسائق التالي عند انتهاء المهلة
 *  - تحديث حالة الرحلة إلى 'no_driver' إذا لم يتوفر أحد
 *
 * الاستخدام:
 *  const { createDriverMatcher } = require('./src/services/driverMatcher');
 *  const { findNearestDriver, sendRequestToDriver } = createDriverMatcher(svc);
 */

const DRIVER_TIMEOUT = 30000; // 30 ثانية لكل سائق

/**
 * Factory — ينشئ دوال البحث مع Dependency Injection.
 * @param {object} svc - كائن الـ services
 * @param {Function} svc.dbAll
 * @param {object}   svc.io - Socket.IO server
 * @param {Map}      svc.tripTimers
 * @param {Function} svc.getDistanceKm
 * @param {Function} svc.safeJSON
 * @param {Function} svc.formatTrip
 * @param {object}   svc.tripRepo - TripRepository
 * @returns {{ findNearestDriver: Function, sendRequestToDriver: Function }}
 */
function createDriverMatcher(svc) {
  const { dbAll, io, tripTimers, getDistanceKm, safeJSON, formatTrip, logger, tripRepo } = svc;

  /**
   * يبحث عن أقرب سائق متاح.
   * @param {number|null} pickupLat
   * @param {number|null} pickupLng
   * @param {number[]} [excludeDriverIds=[]] - IDs السائقين المرفوضين
   * @returns {Promise<object|null>} بيانات السائق أو null
   */
  async function findNearestDriver(pickupLat, pickupLng, excludeDriverIds = []) {
    const exclusion =
      excludeDriverIds.length > 0
        ? `AND d.id NOT IN (${excludeDriverIds.map(() => '?').join(',')})`
        : '';

    const onlineDrivers = await dbAll(
      `SELECT d.*, t.id as taxi_id, t.lat as taxi_lat, t.lng as taxi_lng, t.status as taxi_status
       FROM drivers d
       JOIN taxis t ON t.driver_id = d.id
       WHERE d.status = 'online' AND t.status = 'online' ${exclusion}`,
      excludeDriverIds
    );

    if (onlineDrivers.length === 0) return null;

    if (pickupLat && pickupLng) {
      const withDist = onlineDrivers.map((d) => ({
        ...d,
        distance: getDistanceKm(pickupLat, pickupLng, d.taxi_lat || d.lat, d.taxi_lng || d.lng),
      }));
      withDist.sort((a, b) => a.distance - b.distance);
      return withDist[0];
    }

    return onlineDrivers[0];
  }

  /**
   * يرسل طلب رحلة لسائق محدد، ويبدأ مؤقت 30 ثانية.
   * إذا لم يقبل السائق، ينتقل تلقائياً للسائق التالي.
   * @param {number} tripId
   * @param {object} driver - بيانات السائق
   */
  async function sendRequestToDriver(tripId, driver) {
    try {
      await tripRepo.assignDriver(tripId, driver.id, driver.name, Date.now());

      const trip = await tripRepo.findById(tripId);
      const formatted = formatTrip(trip);

      // إرسال للسائق المحدد
      io.to(`driver:${driver.phone}`).emit('new:trip:request', {
        ...formatted,
        timeoutSeconds: 30,
        message: 'طلب رحلة جديد - لديك 30 ثانية للقبول',
      });
      // إشعار عام لجميع السائقين المتصلين
      io.to('drivers:online').emit('new:trip', formatted);

      logger.info(`Request sent to driver: ${driver.name} for trip #${tripId}`);

      // مؤقت انتهاء المهلة — ينتقل للسائق التالي تلقائياً
      const timer = setTimeout(async () => {
        try {
          const currentTrip = await tripRepo.findById(tripId);
          if (!currentTrip || currentTrip.status !== 'waiting_driver') return;

          logger.warn(
            `Driver ${driver.name} timeout for trip #${tripId} — looking for next driver`
          );

          const rejected = safeJSON(currentTrip.rejected_drivers, []);
          rejected.push(driver.id);
          await tripRepo.setRejectedDrivers(tripId, rejected);

          const nextDriver = await findNearestDriver(
            currentTrip.pickup_lat,
            currentTrip.pickup_lng,
            rejected
          );

          if (nextDriver) {
            await sendRequestToDriver(tripId, nextDriver);
            io.to(`trip:${tripId}`).emit('trip:updated', {
              ...formatTrip(currentTrip),
              message: 'جاري البحث عن سائق آخر...',
            });
          } else {
            await tripRepo.setStatus(tripId, 'no_driver');
            io.to(`trip:${tripId}`).emit('trip:updated', {
              ...formatTrip(currentTrip),
              status: 'no_driver',
              message: 'لا يوجد سائقون متاحون حالياً',
            });
          }
        } catch (e) {
          logger.error('DriverMatcher timer error:', e.message);
        }
      }, DRIVER_TIMEOUT);

      tripTimers.set(`${tripId}`, timer);
    } catch (e) {
      logger.error('sendRequestToDriver error:', e.message);
    }
  }

  return { findNearestDriver, sendRequestToDriver };
}

module.exports = { createDriverMatcher, DRIVER_TIMEOUT };
