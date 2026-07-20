'use strict';

/**
 * Commerce domain — Wallet / Payment / Transaction aggregates (ADR-002 §3, ADR-001).
 * Pure representations of the money surface. No SQL, no SDK, no framework. The
 * aggregates hold the balance/settlement/ledger invariants; the repositories
 * (Infrastructure) own persistence. No behavior beyond the legacy platform's.
 */

const { Money, TransactionType, PaymentStatus } = require('./commerceValues');
const { balancePolicy, ledgerConsistencyPolicy } = require('./commercePolicies');

/**
 * Wallet aggregate — a user's balance (source of truth: `users.balance`).
 * Reconstituted from a `{ balance }` row; exposes sufficiency + credit/debit
 * projections (pure — they compute the post-move figures, they do not persist).
 */
function reconstituteWallet(phone, balanceRow) {
  if (!balanceRow) return null;
  const balance = Number(balanceRow.balance);
  return Object.freeze({
    phone,
    balance,
    money: () => Money(balance),
    canDeduct: (amount) => balancePolicy(balance, amount).sufficient,
    credit: (amount) => ({ before: balance, after: balance + Number(amount) }),
    debit: (amount) => ({ before: balance, after: balance - Number(amount) }),
  });
}

/**
 * Transaction aggregate — one immutable ledger entry. Reconstituted from a
 * transactions row; exposes a consistency self-check against its balance move.
 */
function reconstituteTransaction(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    phone: row.phone,
    type: row.type,
    amount: Number(row.amount),
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    status: row.status,
    isConsistent: () =>
      ledgerConsistencyPolicy({
        type: row.type,
        amount: row.amount,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
      }).consistent,
  });
}

/**
 * Payment aggregate — a settlement intent for a trip fare. Pure factory that
 * produces the ledger entry shape a settlement must write (wallet debit or cash
 * record), mirroring the reused PaymentService exactly. It performs no I/O.
 */
function newPayment({ tripId, phone, amount, ledgerType, balanceBefore, balanceAfter }) {
  return Object.freeze({
    tripId,
    phone,
    type: ledgerType,
    amount: Number(amount),
    balanceBefore,
    balanceAfter,
    status: PaymentStatus.COMPLETED,
    description:
      ledgerType === TransactionType.CASH_PAYMENT
        ? `أجرة نقدية رحلة #${tripId}`
        : `أجرة رحلة #${tripId}`,
  });
}

module.exports = { reconstituteWallet, reconstituteTransaction, newPayment };
