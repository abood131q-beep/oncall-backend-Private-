'use strict';

/**
 * ReportRepository — طبقة الوصول إلى جدول reports
 *
 * المسؤوليات:
 *  - إنشاء بلاغ جديد من المستخدم
 *  - جلب جميع البلاغات للمشرف
 *  - تحديد بلاغ كمُعالَج (resolved)
 *
 * الاستخدام:
 *  const { createReportRepository } = require('./src/repositories/ReportRepository');
 *  const reportRepo = createReportRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {ReportRepository}
 */
function createReportRepository({ dbGet, dbAll, dbRun }) {
  // dbGet مُمرَّر للتوافق مع نمط DI الموحّد في المشروع
  void dbGet;

  return {
    /**
     * ينشئ بلاغاً جديداً.
     * @param {string} phone
     * @param {string} type
     * @param {string} description
     * @param {number|null} tripId
     * @returns {Promise<{lastID: number}>}
     */
    create(phone, type, description, tripId = null) {
      return dbRun('INSERT INTO reports (phone, type, description, trip_id) VALUES (?, ?, ?, ?)', [
        phone,
        type,
        description,
        tripId,
      ]);
    },

    /**
     * يُعيد جميع البلاغات مرتَّبة بالأحدث (للمشرف).
     * @param {number} [limit=100]
     * @returns {Promise<object[]>}
     */
    findAll(limit = 100) {
      return dbAll('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?', [limit]);
    },

    /**
     * يُحدّد بلاغاً كمُعالَج.
     * @param {number|string} id
     */
    resolve(id) {
      return dbRun("UPDATE reports SET status = 'resolved' WHERE id = ?", [id]);
    },
  };
}

module.exports = { createReportRepository };
