'use strict';

/**
 * UserRepository — طبقة الوصول إلى جدول users
 *
 * المسؤوليات:
 *  - البحث عن المستخدم بالهاتف أو المعرّف
 *  - إنشاء مستخدم جديد مع رصيد ابتدائي 10 KD
 *  - تحديث الاسم وحالة الحساب (is_active)
 *  - عمليات القراءة للوحة الإدارة
 *
 * الاستخدام:
 *  const { createUserRepository } = require('./src/repositories/UserRepository');
 *  const userRepo = createUserRepository({ dbGet, dbAll, dbRun });
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {UserRepository}
 */
function createUserRepository({ dbGet, dbAll, dbRun }) {
  return {
    /**
     * يبحث عن مستخدم بالهاتف.
     * @param {string} phone
     * @returns {Promise<object|null>}
     */
    findByPhone(phone) {
      return dbGet('SELECT * FROM users WHERE phone = ?', [phone]);
    },

    /**
     * يبحث عن مستخدم بالمعرّف.
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    findById(id) {
      return dbGet('SELECT * FROM users WHERE id = ?', [id]);
    },

    /**
     * ينشئ مستخدماً جديداً مع رصيد ابتدائي 0 KD (P6-04A).
     * @param {string} phone
     * @param {string} [name='راكب']
     * @returns {Promise<object>} المستخدم الجديد
     */
    async create(phone, name) {
      const result = await dbRun('INSERT INTO users (phone, name, balance) VALUES (?, ?, 0)', [
        phone,
        name || 'راكب',
      ]);
      return dbGet('SELECT * FROM users WHERE id = ?', [result.lastID]);
    },

    /**
     * يحدّث اسم المستخدم ويُعيد الصف المُحدَّث.
     * @param {string} phone
     * @param {string} name
     * @returns {Promise<object|null>}
     */
    async updateName(phone, name) {
      await dbRun('UPDATE users SET name = ? WHERE phone = ?', [name, phone]);
      return dbGet('SELECT * FROM users WHERE phone = ?', [phone]);
    },

    /**
     * يُفعّل أو يُوقف حساب المستخدم.
     * @param {string} phone
     * @param {0|1} isActive
     */
    setActive(phone, isActive) {
      return dbRun('UPDATE users SET is_active = ? WHERE phone = ?', [isActive, phone]);
    },

    /**
     * يُعيد جميع المستخدمين مرتبَّين بتاريخ الإنشاء (للوحة الإدارة).
     * @returns {Promise<object[]>}
     */
    findAll() {
      return dbAll('SELECT * FROM users ORDER BY created_at DESC');
    },

    /**
     * يُعيد عدد المستخدمين الإجمالي.
     * @returns {Promise<number>}
     */
    async count() {
      const row = await dbGet('SELECT COUNT(*) as c FROM users');
      return row ? row.c : 0;
    },
  };
}

module.exports = { createUserRepository };
