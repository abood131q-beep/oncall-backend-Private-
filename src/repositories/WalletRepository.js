'use strict';

/**
 * WalletRepository — طبقة الوصول إلى جداول users (balance) وtransactions
 *
 * المسؤوليات:
 *  - جلب رصيد المستخدم (من users.balance — مصدر الحقيقة الوحيد)
 *  - إضافة/خصم الرصيد بشكل آمن وذري
 *  - تسجيل كل عملية في جدول transactions
 *  - جلب سجل العمليات المالية
 *
 * ملاحظة هندسية: balance مخزّن في users.balance وليس wallets.balance.
 * جدول wallets موجود للتوافق المستقبلي مع نظام محافظ منفصل.
 */

/**
 * @param {{ dbGet: Function, dbAll: Function, dbRun: Function }} db
 * @returns {WalletRepository}
 */
function createWalletRepository({ dbGet, dbAll, dbRun }) {
  return {
    /**
     * يجلب رصيد مستخدم.
     * @param {string} phone
     * @returns {Promise<{balance: number}|null>}
     */
    getBalance(phone) {
      return dbGet('SELECT balance FROM users WHERE phone = ?', [phone]);
    },

    /**
     * يُضيف مبلغاً إلى رصيد المستخدم.
     * @param {string} phone
     * @param {number} amount
     */
    addBalance(phone, amount) {
      return dbRun('UPDATE users SET balance = balance + ? WHERE phone = ?', [
        Number(amount),
        phone,
      ]);
    },

    /**
     * يخصم مبلغاً من رصيد المستخدم إذا كان كافياً — عملية ذرية واحدة.
     *
     * الإصلاح C3: يحل Race Condition بين read-check-write باستخدام
     * جملة UPDATE واحدة تفحص الشرط وتُعدّل في آنٍ واحد.
     * result.changes === 0 يعني الرصيد غير كافٍ (لم تُعدَّل أي صف).
     *
     * @param {string} phone
     * @param {number} amount
     * @returns {Promise<{ success: boolean, balanceAfter?: number }>}
     */
    async deductBalanceSafe(phone, amount) {
      const result = await dbRun(
        'UPDATE users SET balance = balance - ? WHERE phone = ? AND balance >= ?',
        [Number(amount), phone, Number(amount)]
      );
      if (result.changes === 0) return { success: false };
      const row = await dbGet('SELECT balance FROM users WHERE phone = ?', [phone]);
      return { success: true, balanceAfter: row ? row.balance : 0 };
    },

    /**
     * @deprecated استخدم deductBalanceSafe بدلاً منه — غير آمن للاستدعاء المتزامن.
     * محفوظ مؤقتاً للتوافق الداخلي.
     */
    deductBalance(phone, amount) {
      return dbRun('UPDATE users SET balance = balance - ? WHERE phone = ?', [
        Number(amount),
        phone,
      ]);
    },

    /**
     * يُسجّل عملية مالية في جدول transactions.
     * @param {string} phone
     * @param {string} type
     * @param {number} amount
     * @param {number} balanceBefore
     * @param {number} balanceAfter
     * @param {string} description
     * @param {number|null} [tripId]
     * @param {string|null} [status]
     * @returns {Promise<{lastID: number}>}
     */
    logTransaction(
      phone,
      type,
      amount,
      balanceBefore,
      balanceAfter,
      description,
      tripId = null,
      status = null
    ) {
      if (status !== null) {
        return dbRun(
          `INSERT INTO transactions
             (phone, type, amount, balance_before, balance_after, description, trip_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [phone, type, amount, balanceBefore, balanceAfter, description, tripId, status]
        );
      }
      return dbRun(
        `INSERT INTO transactions
           (phone, type, amount, balance_before, balance_after, description, trip_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [phone, type, amount, balanceBefore, balanceAfter, description, tripId]
      );
    },

    /**
     * يجلب سجل العمليات المالية لمستخدم.
     * @param {string} phone
     * @param {number} [limit=50]
     * @returns {Promise<object[]>}
     */
    getTransactions(phone, limit = 50) {
      return dbAll('SELECT * FROM transactions WHERE phone = ? ORDER BY created_at DESC LIMIT ?', [
        phone,
        limit,
      ]);
    },
  };
}

module.exports = { createWalletRepository };
