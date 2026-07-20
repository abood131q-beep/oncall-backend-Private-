'use strict';

/**
 * DriverRepository — طبقة الوصول إلى جداول drivers وtaxis
 *
 * المسؤوليات:
 *  - البحث عن السائق بالهاتف أو المعرّف
 *  - إنشاء سائق جديد مع تعيين taxi افتراضي
 *  - تحديث الحالة والملف الشخصي والتقييم
 *  - جلب رحلات السائق ومراجعاته
 *  - تحديث حالة التاكسي المرتبط
 *
 * الاستخدام:
 *  const { createDriverRepository } = require('./src/repositories/DriverRepository');
 *  const driverRepo = createDriverRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {DriverRepository}
 */
function createDriverRepository({ dbGet, dbAll, dbRun }) {
  return {
    /**
     * يبحث عن سائق بالهاتف.
     * @param {string} phone
     * @returns {Promise<object|null>}
     */
    findByPhone(phone) {
      return dbGet('SELECT * FROM drivers WHERE phone = ?', [phone]);
    },

    /**
     * يبحث عن سائق بالمعرّف.
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    findById(id) {
      return dbGet('SELECT * FROM drivers WHERE id = ?', [id]);
    },

    /**
     * يبحث عن سائق بالاسم.
     * @param {string} name
     * @returns {Promise<object|null>}
     */
    findByName(name) {
      return dbGet('SELECT * FROM drivers WHERE name = ?', [name]);
    },

    /**
     * ينشئ سائقاً جديداً بحالة offline وبانتظار الاعتماد (approval_status='pending').
     * P6-06: approval_status هو مصدر الحقيقة — السائق الجديد لا يحصل على JWT حتى يُعتمَد.
     * @param {string} phone
     * @returns {Promise<object>} السائق الجديد
     */
    async create(phone) {
      const result = await dbRun(
        `INSERT INTO drivers (phone, name, car_name, status, is_active, approval_status, approval_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, DATETIME('now'))`,
        [phone, 'سائق جديد', '', 'offline', 0, 'pending']
      );
      return dbGet('SELECT * FROM drivers WHERE id = ?', [result.lastID]);
    },

    /**
     * يحدّث حالة السائق (online/offline/busy).
     * @param {string} phone
     * @param {string} status
     */
    setStatus(phone, status) {
      return dbRun('UPDATE drivers SET status = ? WHERE phone = ?', [status, phone]);
    },

    /**
     * يحدّث حالة التاكسي المرتبط بالسائق.
     * @param {number} driverId
     * @param {string} status
     */
    setTaxiStatus(driverId, status) {
      return dbRun('UPDATE taxis SET status = ? WHERE driver_id = ?', [status, driverId]);
    },

    /**
     * يحدّث الملف الشخصي للسائق.
     * @param {string} phone
     * @param {string} name
     * @param {string} carName
     * @param {string} plate
     * @returns {Promise<object|null>} السائق المُحدَّث
     */
    async updateProfile(phone, name, carName, plate) {
      await dbRun('UPDATE drivers SET name = ?, car_name = ?, plate = ? WHERE phone = ?', [
        name,
        carName,
        plate,
        phone,
      ]);
      return dbGet('SELECT * FROM drivers WHERE phone = ?', [phone]);
    },

    /**
     * يُفعّل أو يُوقف حساب السائق.
     * @param {string} phone
     * @param {0|1} isActive
     */
    setActive(phone, isActive) {
      return dbRun('UPDATE drivers SET is_active = ? WHERE phone = ?', [isActive, phone]);
    },

    /**
     * يحدّث تقييم السائق ومجموع التقييمات.
     * @param {number} driverId
     * @param {number} rating
     * @param {number} totalRatings
     */
    updateRating(driverId, rating, totalRatings) {
      return dbRun('UPDATE drivers SET rating = ?, total_ratings = ? WHERE id = ?', [
        rating,
        totalRatings,
        driverId,
      ]);
    },

    /**
     * يُعيد جميع السائقين للوحة الإدارة.
     * @returns {Promise<object[]>}
     */
    findAll() {
      return dbAll('SELECT * FROM drivers ORDER BY created_at DESC');
    },

    /**
     * P6-06: يُعيد السائقين الذين approval_status='pending' (بانتظار المراجعة).
     * @returns {Promise<object[]>}
     */
    findPending() {
      return dbAll(
        `SELECT id, phone, name, car_name, plate, created_at
         FROM drivers WHERE approval_status = 'pending' ORDER BY created_at ASC`
      );
    },

    /**
     * P6-06: يُحدِّث approval_status للسائق ويُحدِّث is_active بما يتوافق معه.
     * approval_status هو مصدر الحقيقة — is_active يُشتَق منه للتوافق مع الكود القديم.
     * @param {string} phone
     * @param {'pending'|'approved'|'rejected'|'suspended'} status
     * @param {{ reason?: string, adminPhone?: string }} [opts]
     */
    setApprovalStatus(phone, status, opts = {}) {
      const VALID = ['pending', 'approved', 'rejected', 'suspended'];
      if (!VALID.includes(status)) throw new Error(`approval_status غير صالح: ${status}`);

      const isActive = status === 'approved' ? 1 : 0;

      if (status === 'approved') {
        return dbRun(
          `UPDATE drivers
           SET approval_status      = ?,
               is_active            = ?,
               approved_by          = ?,
               approved_at          = DATETIME('now'),
               approval_updated_at  = DATETIME('now'),
               rejection_reason     = NULL,
               suspended_reason     = NULL
           WHERE phone = ?`,
          [status, isActive, opts.adminPhone || null, phone]
        );
      }

      if (status === 'rejected') {
        return dbRun(
          `UPDATE drivers
           SET approval_status      = ?,
               is_active            = ?,
               rejection_reason     = ?,
               approved_by          = ?,
               approval_updated_at  = DATETIME('now')
           WHERE phone = ?`,
          [status, isActive, opts.reason || null, opts.adminPhone || null, phone]
        );
      }

      if (status === 'suspended') {
        return dbRun(
          `UPDATE drivers
           SET approval_status      = ?,
               is_active            = ?,
               suspended_reason     = ?,
               approved_by          = ?,
               approval_updated_at  = DATETIME('now'),
               status               = 'offline'
           WHERE phone = ?`,
          [status, isActive, opts.reason || null, opts.adminPhone || null, phone]
        );
      }

      // pending
      return dbRun(
        `UPDATE drivers
         SET approval_status      = ?,
             is_active            = ?,
             approval_updated_at  = DATETIME('now')
         WHERE phone = ?`,
        [status, isActive, phone]
      );
    },

    /**
     * P6-06: يُسجِّل عملية اعتماد في driver_approval_logs.
     * @param {{ driverPhone: string, adminPhone: string, action: string, reason?: string, ip?: string }} data
     */
    logApprovalAction({ driverPhone, adminPhone, action, reason, ip }) {
      return dbRun(
        `INSERT INTO driver_approval_logs (driver_phone, admin_phone, action, reason, ip)
         VALUES (?, ?, ?, ?, ?)`,
        [driverPhone, adminPhone, action, reason || null, ip || null]
      );
    },

    /**
     * يجلب التاكسي المرتبط بسائق.
     * @param {number} driverId
     * @returns {Promise<object|null>}
     */
    findTaxi(driverId) {
      return dbGet('SELECT * FROM taxis WHERE driver_id = ?', [driverId]);
    },

    /**
     * يجلب مراجعات (تقييمات) السائق.
     * @param {number} driverId
     * @returns {Promise<object[]>}
     */
    getReviews(driverId) {
      // إخفاء جزئي لرقم الراكب — منع تسريب PII للسائق
      return dbAll(
        `SELECT t.rating, t.rating_comment,
                SUBSTR(t.user_phone, 1, 2) || '****' || SUBSTR(t.user_phone, -2) AS user_phone,
                t.created_at
         FROM trips t
         WHERE t.driver_id = ? AND t.rating IS NOT NULL
         ORDER BY t.created_at DESC LIMIT 20`,
        [driverId]
      );
    },
  };
}

module.exports = { createDriverRepository };
