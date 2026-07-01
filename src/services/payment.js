'use strict';

/**
 * PaymentService — معالجة مدفوعات الرحلات
 *
 * المسؤوليات:
 *  - خصم الأجرة من محفظة المستخدم (wallet) بشكل ذري آمن
 *  - تسجيل الدفع النقدي (cash)
 *  - إنشاء سجل في جدول transactions لكل عملية
 *  - رفض طرق الدفع غير المتاحة بشكل نظيف
 *
 * إصلاح C3 (Race Condition): استخدام deductBalanceSafe بدلاً من check+deduct.
 * العملية ذرية — المستخدم لا يستطيع الحصول على رحلات مجانية بطلبات متزامنة.
 */

function createPaymentService(svc) {
  const { walletRepo, logger } = svc;

  /**
   * يعالج دفع أجرة الرحلة.
   * @param {number} tripId
   * @param {string} phone
   * @param {number} amount
   * @param {string} method  - 'wallet' | 'cash'
   * @returns {Promise<{ success: boolean, method?: string, newBalance?: number, message?: string }>}
   */
  async function processPayment(tripId, phone, amount, method) {
    try {
      if (method === 'wallet') {
        // Atomic check-and-deduct: single SQL statement, no race window
        const { success, balanceAfter } = await walletRepo.deductBalanceSafe(phone, amount);
        if (!success) {
          return { success: false, message: 'رصيد المحفظة غير كافٍ' };
        }

        // balanceBefore ≈ balanceAfter + amount (دقيق للتسجيل)
        const balanceBefore = (balanceAfter ?? 0) + Number(amount);

        await walletRepo.logTransaction(
          phone,
          'trip_payment',
          amount,
          balanceBefore,
          balanceAfter ?? 0,
          `أجرة رحلة #${tripId}`,
          tripId,
          'completed'
        );

        return { success: true, method: 'wallet', newBalance: balanceAfter ?? 0 };
      }

      if (method === 'cash') {
        await walletRepo.logTransaction(
          phone,
          'cash_payment',
          amount,
          0,
          0,
          `أجرة نقدية رحلة #${tripId}`,
          tripId,
          'completed'
        );
        return { success: true, method: 'cash' };
      }

      return { success: false, message: `${method} غير متاح حالياً` };
    } catch (err) {
      logger.error('PaymentService error:', { message: err.message, stack: err.stack });
      return { success: false, message: 'خطأ في الدفع' };
    }
  }

  return { processPayment };
}

module.exports = { createPaymentService };
