'use strict';

/**
 * TripRepository — طبقة الوصول إلى جدول trips
 *
 * المسؤوليات:
 *  - إنشاء الرحلات والبحث عنها (بالمعرّف، بالراكب، بالسائق)
 *  - تحديث حالة الرحلة عبر دورة حياتها الكاملة
 *  - تسجيل تقييمات الركاب والسائقين
 *  - تحديث موقع السائق خلال الرحلة
 *  - الاستعلامات الإدارية (ترقيم، إحصاء، إلغاء، حذف)
 *
 * الاستخدام:
 *  const { createTripRepository } = require('./src/repositories/TripRepository');
 *  const tripRepo = createTripRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {TripRepository}
 */
function createTripRepository({ dbGet, dbAll, dbRun }) {
  return {
    /**
     * يجلب رحلة بالمعرّف.
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    findById(id) {
      return dbGet('SELECT * FROM trips WHERE id = ?', [Number(id)]);
    },

    /**
     * يُعيد آخر N رحلة (جميع الحالات).
     * @param {number} [limit=100]
     * @returns {Promise<object[]>}
     */
    findAll(limit = 100) {
      return dbAll('SELECT * FROM trips ORDER BY created_at DESC LIMIT ?', [limit]);
    },

    /**
     * يُعيد الرحلات المنتظرة سائقاً.
     * @param {number} [limit=50]
     * @returns {Promise<object[]>}
     */
    findWaiting(limit = 50) {
      return dbAll(
        "SELECT * FROM trips WHERE status = 'waiting_driver' ORDER BY created_at DESC LIMIT ?",
        [limit]
      );
    },

    /**
     * يُعيد الرحلات ذات الصلة بسائق (منتظرة + رحلاته).
     * إصلاح H7: حُذف OR driver_name — الاسم غير فريد ويُسرّب رحلات سائقين آخرين بنفس الاسم.
     * @param {number} driverId
     * @param {string} _driverName - محتفَظ به للتوافق الخلفي (غير مستخدم)
     * @param {number} [limit=50]
     * @returns {Promise<object[]>}
     */
    findForDriver(driverId, _driverName, limit = 50) {
      return dbAll(
        `SELECT * FROM trips
         WHERE status = 'waiting_driver' OR driver_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [driverId, limit]
      );
    },

    /**
     * يُعيد رحلات راكب معيّن.
     * @param {string} phone
     * @param {number} [limit=100] - حد أقصى لعدد الرحلات (منع DoS بقوائم ضخمة)
     * @returns {Promise<object[]>}
     */
    findByPassenger(phone, limit = 100) {
      return dbAll('SELECT * FROM trips WHERE user_phone = ? ORDER BY created_at DESC LIMIT ?', [
        phone,
        limit,
      ]);
    },

    /**
     * يُعيد رحلات سائق معيّن.
     * إصلاح H7: حُذف OR driver_name — الاسم غير فريد ويُسرّب رحلات سائقين آخرين بنفس الاسم.
     * @param {number} driverId
     * @param {string} _driverName - محتفَظ به للتوافق الخلفي (غير مستخدم)
     * @param {number} [limit=100]
     * @returns {Promise<object[]>}
     */
    findByDriver(driverId, _driverName, limit = 100) {
      return dbAll(
        `SELECT * FROM trips
         WHERE driver_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [driverId, limit]
      );
    },

    /**
     * يُعيد رحلات مقسّمة بالصفحات مع فلتر اختياري للحالة.
     * @param {number} page - رقم الصفحة (يبدأ من 1)
     * @param {number} limit
     * @param {string|null} [status]
     * @returns {Promise<object[]>}
     */
    findPaginated(page, limit, status = null) {
      const offset = (page - 1) * limit;
      if (status) {
        return dbAll(
          'SELECT * FROM trips WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
          [status, limit, offset]
        );
      }
      return dbAll('SELECT * FROM trips ORDER BY created_at DESC LIMIT ? OFFSET ?', [
        limit,
        offset,
      ]);
    },

    /**
     * يُعيد عدد الرحلات مع فلتر اختياري للحالة.
     * @param {string|null} [status]
     * @returns {Promise<number>}
     */
    async count(status = null) {
      const row = status
        ? await dbGet('SELECT COUNT(*) as c FROM trips WHERE status = ?', [status])
        : await dbGet('SELECT COUNT(*) as c FROM trips');
      return row ? row.c : 0;
    },

    /**
     * ينشئ رحلة جديدة بحالة waiting_driver.
     * @returns {Promise<{lastID: number}>}
     */
    create(
      phone,
      pickup,
      destination,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      estimatedFare,
      paymentMethod = 'cash'
    ) {
      return dbRun(
        `INSERT INTO trips
           (user_phone, pickup, destination,
            pickup_lat, pickup_lng, dest_lat, dest_lng,
            status, estimated_fare, payment_method, route, rejected_drivers)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting_driver', ?, ?, '[]', '[]')`,
        [
          phone || null,
          pickup,
          destination,
          pickupLat || null,
          pickupLng || null,
          destLat || null,
          destLng || null,
          estimatedFare,
          paymentMethod,
        ]
      );
    },

    /**
     * يُسجّل إسناد الرحلة لسائق (أُرسل له الطلب).
     * @param {number} tripId
     * @param {number} driverId
     * @param {string} driverName
     * @param {number} sentAt - timestamp
     */
    assignDriver(tripId, driverId, driverName, sentAt) {
      return dbRun(
        'UPDATE trips SET assigned_driver_id = ?, assigned_driver_name = ?, request_sent_at = ? WHERE id = ?',
        [driverId, driverName, sentAt, tripId]
      );
    },

    /**
     * يُحدّث حالة الرحلة.
     * @param {number} id
     * @param {string} status
     */
    setStatus(id, status) {
      return dbRun('UPDATE trips SET status = ? WHERE id = ?', [status, id]);
    },

    /**
     * يُحدّث قائمة السائقين الرافضين.
     * @param {number} id
     * @param {number[]} rejectedArray
     */
    setRejectedDrivers(id, rejectedArray) {
      return dbRun('UPDATE trips SET rejected_drivers = ? WHERE id = ?', [
        JSON.stringify(rejectedArray),
        id,
      ]);
    },

    /**
     * يُسجّل قبول السائق للرحلة.
     * Atomic test-and-set: يُضيف WHERE status='waiting_driver' لمنع TOCTOU race condition.
     * يُعيد { changes: 1 } عند النجاح، { changes: 0 } إذا سبق سائق آخر القبول.
     * @param {number} tripId
     * @param {number} driverId
     * @param {string} driverName
     * @param {number|null} driverLat
     * @param {number|null} driverLng
     * @returns {Promise<{changes: number}>}
     */
    acceptByDriver(tripId, driverId, driverName, driverLat, driverLng) {
      return dbRun(
        "UPDATE trips SET status = ?, driver_id = ?, driver_name = ?, driver_lat = ?, driver_lng = ? WHERE id = ? AND status = 'waiting_driver'",
        ['accepted', driverId, driverName, driverLat, driverLng, tripId]
      );
    },

    /**
     * يبدأ الرحلة ويُسجّل وقت الانطلاق.
     * @param {number} id
     * @param {number} startTime - timestamp
     */
    startTrip(id, startTime) {
      return dbRun('UPDATE trips SET status = ?, start_time = ?, route = ? WHERE id = ?', [
        'in_progress',
        startTime,
        '[]',
        id,
      ]);
    },

    /**
     * يُنهي الرحلة ويُسجّل الأجرة والمسافة والمدة.
     * @param {number} id
     * @param {number} finalFare
     * @param {number} totalDistanceKm
     * @param {number} durationMinutes
     */
    completeTrip(id, finalFare, totalDistanceKm, durationMinutes) {
      return dbRun(
        'UPDATE trips SET status = ?, end_time = CURRENT_TIMESTAMP, final_fare = ?, total_distance = ?, duration_minutes = ? WHERE id = ?',
        ['completed', finalFare, Math.round(totalDistanceKm * 1000) / 1000, durationMinutes, id]
      );
    },

    /**
     * يُحدّث موقع السائق ومسار الرحلة.
     * @param {number} id
     * @param {number} lat
     * @param {number} lng
     * @param {object[]} routeArray
     */
    updateLocation(id, lat, lng, routeArray) {
      return dbRun('UPDATE trips SET driver_lat = ?, driver_lng = ?, route = ? WHERE id = ?', [
        lat,
        lng,
        JSON.stringify(routeArray),
        id,
      ]);
    },

    /**
     * يُعيد إحصائيات سائق مُجمَّعة من قاعدة البيانات مباشرةً.
     * M-005: استبدال تحميل 1000 رحلة بـ SQL aggregation — O(1) بدلاً من O(n).
     * @param {number} driverId
     * @returns {Promise<object>} صف واحد يحتوي على جميع الإحصائيات
     */
    getStats(driverId) {
      return dbGet(
        `SELECT
           COUNT(*)                                                                   AS totalTrips,
           COUNT(CASE WHEN status = 'completed'  THEN 1 END)                         AS completedTrips,
           COUNT(CASE WHEN status = 'cancelled'  THEN 1 END)                         AS cancelledTrips,
           COUNT(CASE WHEN status != 'waiting_driver' THEN 1 END)                    AS respondedTrips,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN final_fare    ELSE 0 END), 0) AS totalEarnings,
           COALESCE(SUM(CASE WHEN status = 'completed'
                              AND date(created_at) = date('now','localtime')
                             THEN final_fare ELSE 0 END), 0)                          AS todayEarnings,
           COALESCE(SUM(CASE WHEN status = 'completed'
                              AND created_at >= datetime('now','-7 days')
                             THEN final_fare ELSE 0 END), 0)                          AS weekEarnings,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_minutes ELSE 0 END), 0) AS totalMinutes,
           COALESCE(AVG(CASE WHEN status = 'completed' AND rating IS NOT NULL THEN rating END), 5.0) AS avgRating,
           COUNT(CASE WHEN status = 'completed' AND rating IS NOT NULL THEN 1 END)   AS ratedCount
         FROM trips
         WHERE driver_id = ?`,
        [driverId]
      );
    },

    /**
     * يُسجّل تقييم الراكب للسائق.
     * @param {number} id
     * @param {number} rating
     * @param {string|null} comment
     */
    rateByPassenger(id, rating, comment) {
      return dbRun('UPDATE trips SET rating = ?, rating_comment = ? WHERE id = ?', [
        rating,
        comment || null,
        id,
      ]);
    },

    /**
     * يُعيد تقييمات سائق معيّن (لحساب المتوسط).
     * @param {number} driverId
     * @returns {Promise<object[]>}
     */
    getRatingsByDriver(driverId) {
      return dbAll('SELECT rating FROM trips WHERE driver_id = ? AND rating IS NOT NULL', [
        driverId,
      ]);
    },

    /**
     * يُسجّل تقييم السائق للراكب.
     * @param {number} id
     * @param {number} rating
     * @param {string|null} comment
     */
    rateByDriver(id, rating, comment) {
      return dbRun(
        'UPDATE trips SET passenger_rating = ?, driver_rating_comment = ? WHERE id = ?',
        [rating, comment || null, id]
      );
    },

    /**
     * يُلغي رحلة بواسطة المشرف.
     * @param {number} id
     */
    cancelByAdmin(id) {
      return dbRun("UPDATE trips SET status = 'cancelled', cancelled_by = 'admin' WHERE id = ?", [
        id,
      ]);
    },

    /**
     * يحذف جميع الرحلات (Admin — إعادة تعيين).
     */
    deleteAll() {
      return dbRun('DELETE FROM trips');
    },
  };
}

module.exports = { createTripRepository };
