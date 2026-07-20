'use strict';

/**
 * ScooterRepository — طبقة الوصول إلى جداول scooters وscooter_rides
 *
 * المسؤوليات:
 *  - جلب السكوترات وتفاصيلها
 *  - فتح القفل (unlock) وإنهاء الرحلة (end-ride)
 *  - جلب سجل الرحلات وحالة السكوتر النشط
 *  - عمليات الإدارة (إنشاء، حذف، إعادة تعيين)
 *
 * الاستخدام:
 *  const { createScooterRepository } = require('./src/repositories/ScooterRepository');
 *  const scooterRepo = createScooterRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {ScooterRepository}
 */
function createScooterRepository({ dbGet, dbAll, dbRun }) {
  return {
    /**
     * يُعيد جميع السكوترات مرتَّبة حسب الحالة والبطارية.
     * @returns {Promise<object[]>}
     */
    findAll() {
      return dbAll('SELECT * FROM scooters ORDER BY status ASC, battery DESC');
    },

    /**
     * يجلب سكوتراً بالمعرّف.
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    findById(id) {
      return dbGet('SELECT * FROM scooters WHERE id = ?', [Number(id)]);
    },

    /**
     * يجلب السكوتر النشط لمستخدم معيّن.
     * @param {string} phone
     * @returns {Promise<object|null>}
     */
    findActiveByPhone(phone) {
      return dbGet('SELECT * FROM scooters WHERE current_user_phone = ? AND status = ?', [
        phone,
        'riding',
      ]);
    },

    /**
     * يُحوِّل السكوتر إلى حالة riding ويُسجّل بداية الرحلة.
     * Atomic test-and-set: يُضيف WHERE status='available' لمنع TOCTOU race condition.
     * يُعيد { changes: 1 } عند النجاح، { changes: 0 } إذا سبق شخص آخر الفتح.
     * @param {number} scooterId
     * @param {string} phone
     * @param {number} startTime - timestamp
     * @returns {Promise<{changes: number}>}
     */
    setRiding(scooterId, phone, startTime) {
      return dbRun(
        "UPDATE scooters SET status=?, current_user_phone=?, ride_start_time=? WHERE id=? AND status='available'",
        ['riding', phone, startTime, scooterId]
      );
    },

    /**
     * ينشئ سجل رحلة جديد.
     * @param {number} scooterId
     * @param {string} phone
     * @param {number} startTime
     * @returns {Promise<{lastID: number}>}
     */
    createRide(scooterId, phone, startTime) {
      return dbRun(
        'INSERT INTO scooter_rides (scooter_id, user_phone, start_time, status) VALUES (?,?,?,?)',
        [scooterId, phone, startTime, 'active']
      );
    },

    /**
     * يُنهي رحلة في جدول scooter_rides.
     * @param {number} scooterId
     * @param {string} phone
     * @param {number} endTime
     * @param {number} durationMinutes
     * @param {number} fare
     * @param {number|null} endLat
     * @param {number|null} endLng
     */
    endRideRecord(scooterId, phone, endTime, durationMinutes, fare, endLat, endLng) {
      return dbRun(
        'UPDATE scooter_rides SET end_time=?, duration_minutes=?, fare=?, end_lat=?, end_lng=?, status=? WHERE scooter_id=? AND user_phone=? AND status=?',
        [
          endTime,
          durationMinutes,
          fare,
          endLat || null,
          endLng || null,
          'completed',
          scooterId,
          phone,
          'active',
        ]
      );
    },

    /**
     * يُعيد السكوتر إلى حالة available بعد انتهاء الرحلة.
     * @param {number} scooterId
     * @param {number} newBattery
     * @param {number|null} endLat
     * @param {number|null} endLng
     * @param {number} currentLat - القيمة الاحتياطية
     * @param {number} currentLng - القيمة الاحتياطية
     */
    setAvailable(scooterId, newBattery, endLat, endLng, currentLat, currentLng) {
      return dbRun(
        'UPDATE scooters SET status=?, current_user_phone=NULL, ride_start_time=NULL, battery=?, lat=?, lng=?, total_rentals=total_rentals+1 WHERE id=?',
        ['available', newBattery, endLat || currentLat, endLng || currentLng, scooterId]
      );
    },

    /**
     * يجلب سجل رحلات مستخدم.
     * @param {string} phone
     * @returns {Promise<object[]>}
     */
    getRideHistory(phone) {
      return dbAll(
        `SELECT sr.*, s.name as scooter_name, s.scooter_code
         FROM scooter_rides sr
         LEFT JOIN scooters s ON s.id = sr.scooter_id
         WHERE sr.user_phone = ? ORDER BY sr.start_time DESC LIMIT 20`,
        [phone]
      );
    },

    /**
     * ينشئ سكوتراً جديداً (Admin).
     * @param {string} name
     * @param {string} scooterCode
     * @param {number} lat
     * @param {number} lng
     * @param {number} battery
     * @returns {Promise<{lastID: number}>}
     */
    create(name, scooterCode, lat, lng, battery) {
      return dbRun(
        'INSERT INTO scooters (name, scooter_code, lat, lng, battery, status) VALUES (?,?,?,?,?,?)',
        [name, scooterCode, lat || 29.3759, lng || 47.9774, battery || 100, 'available']
      );
    },

    /**
     * يحذف سكوتراً (Admin).
     * @param {number} id
     */
    delete(id) {
      return dbRun('DELETE FROM scooters WHERE id = ?', [id]);
    },

    /**
     * يُعيد تعيين جميع السكوترات إلى available (Admin).
     */
    resetAll() {
      return dbRun("UPDATE scooters SET status = 'available'");
    },
  };
}

module.exports = { createScooterRepository };
