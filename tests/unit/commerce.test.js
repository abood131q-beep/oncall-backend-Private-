'use strict';

/**
 * Commerce slice tests — proves the migrated Domain + Application layers
 * reproduce the legacy wallet/payment behavior with pure fakes (no transport, no
 * storage, no payment SDK — the layering promise, verified). Covers the value
 * objects, the six policies (incl. explicit LEDGER-CONSISTENCY and IDEMPOTENCY
 * tests mandated by ADR-001), the aggregates, and the four use cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Money,
  Currency,
  PaymentMethod,
  isPaymentMethod,
  TransactionType,
  MAX_CHARGE,
} = require('../../src/domain/commerce/commerceValues');
const {
  paymentValidationPolicy,
  balancePolicy,
  settlementPolicy,
  refundPolicy,
  idempotencyPolicy,
  ledgerConsistencyPolicy,
  ownershipPolicy,
  CommerceRejection,
} = require('../../src/domain/commerce/commercePolicies');
const {
  reconstituteWallet,
  reconstituteTransaction,
  newPayment,
} = require('../../src/domain/commerce/Commerce');
const { createCommerceApplication, CommerceError } = require('../../src/application/commerce');

// ── Domain: value objects ────────────────────────────────────────────────────

test('Money formats KWD with 3 decimals (legacy toFixed(3))', () => {
  assert.equal(Money(12.5).format(), '12.500');
  assert.equal(Money(5).currency, Currency.KWD);
  assert.equal(Money('abc').isValidNumber, false);
  assert.equal(isPaymentMethod('wallet'), true);
  assert.equal(isPaymentMethod('bitcoin'), false);
  assert.equal(MAX_CHARGE, 500);
});

// ── Domain: policies ─────────────────────────────────────────────────────────

test('paymentValidationPolicy enforces the (0, 500] charge envelope', () => {
  assert.equal(paymentValidationPolicy(0).code, CommerceRejection.BAD_AMOUNT);
  assert.equal(paymentValidationPolicy(-5).code, CommerceRejection.BAD_AMOUNT);
  assert.equal(paymentValidationPolicy(501).code, CommerceRejection.BAD_AMOUNT);
  assert.equal(paymentValidationPolicy('x').code, CommerceRejection.BAD_AMOUNT);
  assert.deepEqual(paymentValidationPolicy(500), { allowed: true, amount: 500 });
  assert.deepEqual(paymentValidationPolicy('12.5'), { allowed: true, amount: 12.5 });
});

test('balancePolicy mirrors the atomic-deduct sufficiency (balance >= amount)', () => {
  assert.equal(balancePolicy(10, 10).sufficient, true);
  assert.equal(balancePolicy(10, 10.001).sufficient, false);
  assert.equal(balancePolicy(0, 1).sufficient, false);
});

test('settlementPolicy classifies wallet (debit) vs cash (no move) vs unsupported', () => {
  assert.deepEqual(settlementPolicy(PaymentMethod.WALLET), {
    allowed: true,
    movesBalance: true,
    ledgerType: TransactionType.TRIP_PAYMENT,
  });
  assert.deepEqual(settlementPolicy(PaymentMethod.CASH), {
    allowed: true,
    movesBalance: false,
    ledgerType: TransactionType.CASH_PAYMENT,
  });
  assert.equal(settlementPolicy('knet').code, CommerceRejection.UNSUPPORTED_METHOD);
});

test('refundPolicy allows only completed debits (no refund flow wired today)', () => {
  assert.equal(refundPolicy({ status: 'completed', type: 'trip_payment' }).allowed, true);
  assert.equal(refundPolicy({ status: 'pending', type: 'trip_payment' }).allowed, false);
  assert.equal(refundPolicy({ status: 'completed', type: 'deposit' }).allowed, false);
  assert.equal(refundPolicy(null).code, CommerceRejection.BAD_AMOUNT);
});

// ── IDEMPOTENCY (ADR-001 — one completed trip_payment per trip) ──────────────

test('idempotencyPolicy detects a duplicate completed trip payment', () => {
  assert.equal(idempotencyPolicy([]).duplicate, false);
  assert.equal(idempotencyPolicy([{ type: 'trip_payment', status: 'completed' }]).duplicate, true);
  // a pending or non-trip row is not a completed settlement
  assert.equal(idempotencyPolicy([{ type: 'trip_payment', status: 'pending' }]).duplicate, false);
  assert.equal(idempotencyPolicy([{ type: 'deposit', status: 'completed' }]).duplicate, false);
});

// ── LEDGER CONSISTENCY (double-entry-style reconciliation) ───────────────────

test('ledgerConsistencyPolicy reconciles credit/debit/cash balance moves', () => {
  assert.equal(
    ledgerConsistencyPolicy({ type: 'deposit', amount: 5, balanceBefore: 10, balanceAfter: 15 })
      .consistent,
    true
  );
  assert.equal(
    ledgerConsistencyPolicy({ type: 'deposit', amount: 5, balanceBefore: 10, balanceAfter: 14 })
      .consistent,
    false
  );
  assert.equal(
    ledgerConsistencyPolicy({ type: 'trip_payment', amount: 3, balanceBefore: 10, balanceAfter: 7 })
      .consistent,
    true
  );
  assert.equal(
    ledgerConsistencyPolicy({ type: 'cash_payment', amount: 3, balanceBefore: 0, balanceAfter: 0 })
      .consistent,
    true
  );
});

test('ownershipPolicy enforces IDOR (path phone must equal JWT phone)', () => {
  assert.equal(ownershipPolicy('123', '123').allowed, true);
  assert.equal(ownershipPolicy('123', '999').allowed, false);
});

// ── Domain: aggregates ───────────────────────────────────────────────────────

test('wallet aggregate exposes sufficiency + credit/debit projections', () => {
  assert.equal(reconstituteWallet('p', null), null);
  const w = reconstituteWallet('p', { balance: 10 });
  assert.equal(w.canDeduct(10), true);
  assert.equal(w.canDeduct(11), false);
  assert.deepEqual(w.credit(5), { before: 10, after: 15 });
  assert.deepEqual(w.debit(4), { before: 10, after: 6 });
});

test('transaction aggregate self-checks ledger consistency; newPayment builds the debit row', () => {
  const good = reconstituteTransaction({
    id: 1,
    phone: 'p',
    type: 'trip_payment',
    amount: 3,
    balance_before: 10,
    balance_after: 7,
    status: 'completed',
  });
  assert.equal(good.isConsistent(), true);
  const pay = newPayment({
    tripId: 42,
    phone: 'p',
    amount: 3,
    ledgerType: TransactionType.TRIP_PAYMENT,
    balanceBefore: 10,
    balanceAfter: 7,
  });
  assert.equal(pay.status, 'completed');
  assert.equal(pay.description, 'أجرة رحلة #42');
});

// ── Application: orchestration over pure fakes ───────────────────────────────

function makeApp(overrides = {}) {
  const base = {
    walletRepository: {
      getUser: async (p) => (p === 'known' ? { phone: 'known', balance: 10 } : null),
      getBalance: async (p) => (p === 'known' ? { balance: 15 } : null),
      addBalance: async () => {},
      deductBalanceSafe: async () => ({ success: true, balanceAfter: 7 }),
    },
    ledgerRepository: {
      logTransaction: async () => ({ lastID: 1 }),
      getTransactions: async () => [{ id: 1, type: 'deposit', amount: 5 }],
    },
    paymentGateway: {
      isEnabled: () => true,
      listMethods: () => [{ id: 'cash' }, { id: 'wallet' }],
    },
    notificationGateway: { send: async () => {} },
    auditRepository: { record: async () => ({ recorded: true }) },
  };
  return createCommerceApplication({ ...base, ...overrides });
}

test('assertPorts fails fast when a Commerce port method is missing', () => {
  assert.throws(
    () => makeApp({ ledgerRepository: { logTransaction: async () => {} } }),
    /ledgerRepository/
  );
});

test('getPaymentMethods returns the reused catalog', async () => {
  const r = await makeApp().useCases.getPaymentMethods();
  assert.equal(r.value.methods.length, 2);
});

test('chargeWallet: envelope 400, gateway 503, missing user 404, success credits + notifies', async () => {
  let notified = false;
  let logged = null;
  const app = makeApp({
    notificationGateway: {
      send: async () => {
        notified = true;
      },
    },
    ledgerRepository: {
      logTransaction: async (...args) => {
        logged = args;
        return { lastID: 1 };
      },
      getTransactions: async () => [],
    },
  });
  assert.equal(
    (
      await app.useCases.chargeWallet(
        app.commands.chargeCommand({ phone: 'known', amount: 9999 }).command
      )
    ).code,
    CommerceError.BAD_AMOUNT
  );
  const disabled = makeApp({ paymentGateway: { isEnabled: () => false, listMethods: () => [] } });
  assert.equal(
    (
      await disabled.useCases.chargeWallet(
        disabled.commands.chargeCommand({ phone: 'known', amount: 5 }).command
      )
    ).code,
    CommerceError.GATEWAY_UNAVAILABLE
  );
  assert.equal(
    (
      await app.useCases.chargeWallet(
        app.commands.chargeCommand({ phone: 'ghost', amount: 5 }).command
      )
    ).code,
    CommerceError.USER_NOT_FOUND
  );
  const ok = await app.useCases.chargeWallet(
    app.commands.chargeCommand({ phone: 'known', amount: 5, method: 'knet' }).command
  );
  assert.deepEqual(ok.value, { balance: 15, amount: 5 });
  assert.equal(notified, true);
  assert.equal(logged[1], 'deposit'); // ledger type
});

test('getWalletBalance: IDOR 403, missing 404, success', async () => {
  const app = makeApp();
  assert.equal(
    (
      await app.useCases.getWalletBalance(
        app.commands.walletQueryCommand({ paramPhone: 'a', authPhone: 'b' }).command
      )
    ).code,
    CommerceError.FORBIDDEN
  );
  assert.equal(
    (
      await app.useCases.getWalletBalance(
        app.commands.walletQueryCommand({ paramPhone: 'x', authPhone: 'x' }).command
      )
    ).code,
    CommerceError.BALANCE_NOT_FOUND
  );
  const ok = await app.useCases.getWalletBalance(
    app.commands.walletQueryCommand({ paramPhone: 'known', authPhone: 'known' }).command
  );
  assert.deepEqual(ok.value, { balance: 15 });
});

test('getWalletTransactions: IDOR 403, else history + balance (0 when no row)', async () => {
  const app = makeApp();
  assert.equal(
    (
      await app.useCases.getWalletTransactions(
        app.commands.walletQueryCommand({ paramPhone: 'a', authPhone: 'b' }).command
      )
    ).code,
    CommerceError.FORBIDDEN
  );
  const ok = await app.useCases.getWalletTransactions(
    app.commands.walletQueryCommand({ paramPhone: 'known', authPhone: 'known' }).command
  );
  assert.equal(ok.value.balance, 15);
  assert.equal(ok.value.transactions.length, 1);
});
