'use strict';

/**
 * Commerce domain — Policies (ADR-002 §5, ADR-005 §1, ADR-001).
 * The invariants of money movement; the Application asks, this module decides.
 * Pure: no I/O, no SQL, no payment SDK, no framework. Every rule is a 1:1
 * extraction of a decision that already lives in the legacy wallet/payment code
 * (charge envelope, atomic-deduct sufficiency, wallet-vs-cash settlement,
 * balance bookkeeping, one-payment-per-trip idempotency). No new financial rule.
 */

const {
  PaymentMethod,
  PaymentStatus,
  TransactionType,
  MAX_CHARGE,
  MIN_CHARGE_EXCLUSIVE,
} = require('./commerceValues');

const CommerceRejection = Object.freeze({
  BAD_AMOUNT: 'BAD_AMOUNT',
  GATEWAY_UNAVAILABLE: 'GATEWAY_UNAVAILABLE',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  BALANCE_NOT_FOUND: 'BALANCE_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
});

/**
 * PaymentValidationPolicy — a wallet charge must be a positive amount within the
 * envelope (0, MAX_CHARGE] (verbatim legacy `/wallet/charge` guard).
 */
function paymentValidationPolicy(amount) {
  const n = Number(amount);
  if (!amount || !Number.isFinite(n) || n <= MIN_CHARGE_EXCLUSIVE || n > MAX_CHARGE) {
    return { allowed: false, code: CommerceRejection.BAD_AMOUNT };
  }
  return { allowed: true, amount: n };
}

/**
 * BalancePolicy — funds are sufficient iff balance ≥ amount (the exact condition
 * the atomic `deductBalanceSafe` SQL enforces: `balance >= ?`).
 */
function balancePolicy(balance, amount) {
  const b = Number(balance);
  const a = Number(amount);
  return { sufficient: Number.isFinite(b) && Number.isFinite(a) && b >= a };
}

/**
 * SettlementPolicy — how a trip fare settles by method (mirrors PaymentService):
 *  - wallet → atomic deduct + ledger row (fails on insufficient funds)
 *  - cash   → ledger row only (no balance movement)
 *  - other  → unsupported
 * Pure classification; the actual settlement is reused via the gateway.
 */
function settlementPolicy(method) {
  if (method === PaymentMethod.WALLET) {
    return { allowed: true, movesBalance: true, ledgerType: TransactionType.TRIP_PAYMENT };
  }
  if (method === PaymentMethod.CASH) {
    return { allowed: true, movesBalance: false, ledgerType: TransactionType.CASH_PAYMENT };
  }
  return { allowed: false, code: CommerceRejection.UNSUPPORTED_METHOD };
}

/**
 * RefundPolicy — a transaction is refundable only if it was a completed debit
 * (trip/cash payment). No refund flow is wired today (none exists in the legacy
 * platform); this encodes the invariant for a future, separately-governed flow
 * and adds no capability now.
 */
function refundPolicy(transaction) {
  if (!transaction) return { allowed: false, code: CommerceRejection.BAD_AMOUNT };
  const isCompletedDebit =
    transaction.status === PaymentStatus.COMPLETED &&
    (transaction.type === TransactionType.TRIP_PAYMENT ||
      transaction.type === TransactionType.CASH_PAYMENT);
  return { allowed: Boolean(isCompletedDebit) };
}

/**
 * IdempotencyPolicy — settlement is idempotent per trip: at most ONE completed
 * `trip_payment` ledger row per trip (the C-1 / ADR-001 guarantee, enforced at
 * runtime by the serialized completion transaction). A second settlement for a
 * trip that already has a completed payment is a duplicate and must not charge.
 */
function idempotencyPolicy(existingTripPayments) {
  const already = (Array.isArray(existingTripPayments) ? existingTripPayments : []).some(
    (t) => t && t.type === TransactionType.TRIP_PAYMENT && t.status === PaymentStatus.COMPLETED
  );
  return { duplicate: already, key: 'trip_payment' };
}

/**
 * LedgerConsistencyPolicy — a ledger row must reconcile with the balance move:
 *  - credit (deposit): balance_after = balance_before + amount
 *  - debit  (payment): balance_after = balance_before − amount
 *  - cash: no balance movement (before == after, legacy writes 0/0)
 * Pure double-entry-style consistency check over already-computed figures.
 */
function ledgerConsistencyPolicy({ type, amount, balanceBefore, balanceAfter }) {
  const a = Number(amount);
  const before = Number(balanceBefore);
  const after = Number(balanceAfter);
  if (type === TransactionType.DEPOSIT) return { consistent: after === before + a };
  if (type === TransactionType.TRIP_PAYMENT) return { consistent: after === before - a };
  if (type === TransactionType.CASH_PAYMENT) return { consistent: before === after };
  return { consistent: false };
}

/**
 * OwnershipPolicy (ADR-007 IDOR) — a caller may read only their own wallet: the
 * path phone must equal the JWT phone (verbatim legacy `params.phone !== phone`).
 */
function ownershipPolicy(paramPhone, authPhone) {
  return { allowed: paramPhone === authPhone };
}

module.exports = {
  CommerceRejection,
  paymentValidationPolicy,
  balancePolicy,
  settlementPolicy,
  refundPolicy,
  idempotencyPolicy,
  ledgerConsistencyPolicy,
  ownershipPolicy,
};
