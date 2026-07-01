'use strict';

/**
 * NotificationRepository — طبقة الوصول إلى جدول notifications
 *
 * المسؤوليات:
 *  - إرسال إشعارات للمستخدمين (عام ومرتبط برحلة)
 *  - جلب إشعارات مستخدم معيّن
 *  - تحديد الإشعارات كمقروءة
 *
 * الاستخدام:
 *  const { createNotificationRepository } = require('./src/repositories/NotificationRepository');
 *  const notifRepo = createNotificationRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {NotificationRepository}
 */
function createNotificationRepository({ dbGet, dbAll, dbRun }) {
  // dbGet مُمرَّر للتوافق مع نمط DI الموحّد في المشروع
  void dbGet;

  return {
    /**
     * يُرسل إشعاراً بسيطاً (بدون trip_id).
     * @param {string} phone
     * @param {string} title
     * @param {string} body
     * @param {string} type
     * @returns {Promise<{lastID: number}>}
     */
    send(phone, title, body, type) {
      return dbRun(`INSERT INTO notifications (phone, title, body, type) VALUES (?, ?, ?, ?)`, [
        phone,
        title,
        body,
        type,
      ]);
    },

    /**
     * يُرسل إشعاراً مرتبطاً برحلة.
     * @param {string} phone
     * @param {string} title
     * @param {string} body
     * @param {string} type
     * @param {number} tripId
     * @returns {Promise<{lastID: number}>}
     */
    sendForTrip(phone, title, body, type, tripId) {
      return dbRun(
        `INSERT INTO notifications (phone, title, body, type, trip_id) VALUES (?, ?, ?, ?, ?)`,
        [phone, title, body, type, tripId]
      );
    },

    /**
     * يجلب إشعارات مستخدم.
     * @param {string} phone
     * @param {number} [limit=20]
     * @returns {Promise<object[]>}
     */
    findByPhone(phone, limit = 20) {
      return dbAll('SELECT * FROM notifications WHERE phone = ? ORDER BY created_at DESC LIMIT ?', [
        phone,
        limit,
      ]);
    },

    /**
     * يُحدّد جميع إشعارات مستخدم كمقروءة.
     * @param {string} phone
     */
    markAllRead(phone) {
      return dbRun('UPDATE notifications SET is_read = 1 WHERE phone = ?', [phone]);
    },
  };
}

module.exports = { createNotificationRepository };
