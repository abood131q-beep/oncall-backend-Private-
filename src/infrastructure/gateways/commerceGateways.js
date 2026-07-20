'use strict';

/**
 * Commerce gateways — Infrastructure layer.
 * Implement paymentGateway / notificationGateway / auditRepository by reusing
 * EXISTING integrations only: the `PAYMENT_ENABLED` posture and the static
 * payment-method catalog (verbatim from the legacy payment router), the
 * notification sender (`notifRepo.send`), and the structured `logger` audit
 * fabric. No payment SDK is imported; no new provider is added (ADR-001 keeps the
 * real gateway a future, separately-governed integration).
 *
 * @param {object} deps — the existing DI service container
 */

// The legacy static method catalog — byte-identical to src/routes/payment.js.
const PAYMENT_METHODS = {
  cash: { id: 'cash', name: 'نقداً', icon: '💵', available: true },
  wallet: { id: 'wallet', name: 'المحفظة', icon: '👛', available: true },
  knet: { id: 'knet', name: 'كي نت', icon: '💳', available: false, note: 'قريباً' },
  visa: { id: 'visa', name: 'فيزا/ماستر', icon: '💳', available: false, note: 'قريباً' },
  apple_pay: { id: 'apple_pay', name: 'Apple Pay', icon: '🍎', available: false, note: 'قريباً' },
};

function createCommercePaymentGateway(deps) {
  const { PAYMENT_ENABLED } = deps;
  return {
    isEnabled: () => Boolean(PAYMENT_ENABLED),
    listMethods: () => Object.values(PAYMENT_METHODS),
  };
}

function createCommerceNotificationGateway(deps) {
  const { notifRepo } = deps;
  return {
    send: (phone, title, body, type) => notifRepo.send(phone, title, body, type),
  };
}

function createCommerceAuditRepository(deps) {
  const { logger } = deps;
  return {
    record(event, data) {
      if (logger && typeof logger.info === 'function') logger.info(event, data);
      return { recorded: true };
    },
  };
}

module.exports = {
  createCommercePaymentGateway,
  createCommerceNotificationGateway,
  createCommerceAuditRepository,
};
