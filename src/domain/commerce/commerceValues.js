'use strict';

/**
 * Commerce domain — Value Objects (ADR-002 §4, ADR-001).
 * Pure vocabulary for the wallet/payment/ledger surface. No SQL, no payment SDK,
 * no framework, no I/O. Encodes ONLY what already exists: the KWD money model
 * (3-decimal dinar, the legacy `toFixed(3)`), the transaction types and payment
 * methods the platform already writes, and the charge envelope (max 500 KWD).
 * No new financial concept is introduced.
 */

/** Currency — the platform operates in Kuwaiti Dinar (3 minor-unit decimals). */
const Currency = Object.freeze({
  KWD: Object.freeze({ code: 'KWD', decimals: 3, symbol: 'د.ك' }),
});

/** Money VO — an amount bound to a currency; formatting mirrors legacy toFixed. */
function Money(amount, currency = Currency.KWD) {
  const n = Number(amount);
  return Object.freeze({
    amount: n,
    currency,
    isValidNumber: Number.isFinite(n),
    format: () => (Number.isFinite(n) ? n.toFixed(currency.decimals) : String(amount)),
  });
}

/** PaymentMethod VO — the methods the platform already recognizes. */
const PaymentMethod = Object.freeze({
  CASH: 'cash',
  WALLET: 'wallet',
  KNET: 'knet',
  VISA: 'visa',
  APPLE_PAY: 'apple_pay',
});
const PAYMENT_METHOD_VALUES = Object.freeze(Object.values(PaymentMethod));
function isPaymentMethod(m) {
  return PAYMENT_METHOD_VALUES.includes(m);
}

/** PaymentStatus VO — the transaction statuses already used in the ledger. */
const PaymentStatus = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/** TransactionType VO — the ledger row types the platform already writes. */
const TransactionType = Object.freeze({
  DEPOSIT: 'deposit',
  TRIP_PAYMENT: 'trip_payment',
  CASH_PAYMENT: 'cash_payment',
});

// Identity value objects — normalize inbound identifiers (no existence claim).
function WalletId(phone) {
  return phone == null ? null : String(phone);
}
function PaymentId(id) {
  return id == null ? null : String(id);
}
function TransactionId(id) {
  return id == null ? null : String(id);
}

// The legacy wallet-charge envelope (verbatim): amount in (0, 500] KWD.
const MAX_CHARGE = 500;
const MIN_CHARGE_EXCLUSIVE = 0;

module.exports = {
  Currency,
  Money,
  PaymentMethod,
  PAYMENT_METHOD_VALUES,
  isPaymentMethod,
  PaymentStatus,
  TransactionType,
  WalletId,
  PaymentId,
  TransactionId,
  MAX_CHARGE,
  MIN_CHARGE_EXCLUSIVE,
};
