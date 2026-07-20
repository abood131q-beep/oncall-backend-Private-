'use strict';

/**
 * Commerce use cases — Application layer (ADR-005 §5/§6, ADR-001).
 * Validation (domain policy) → authorization (ownership + admin gate is the
 * middleware) → orchestration via ports → typed result. A 1:1 migration of the
 * four Commerce endpoints in the legacy payment router. The atomic wallet ops,
 * the ledger, the gateway posture, and the notifier are reused behind the ports,
 * never reimplemented — financial behavior is preserved byte-for-byte.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 */

const {
  paymentValidationPolicy,
  ownershipPolicy,
  CommerceRejection,
} = require('../../domain/commerce/commercePolicies');
const { TransactionType } = require('../../domain/commerce/commerceValues');

const CommerceError = Object.freeze({ ...CommerceRejection });

function createCommerceUseCases(ports) {
  const {
    walletRepository,
    ledgerRepository,
    paymentGateway,
    notificationGateway,
    auditRepository,
  } = ports;

  // GET /payment/methods — static method catalog (no auth, no I/O).
  async function getPaymentMethods() {
    return { ok: true, value: { methods: paymentGateway.listMethods() } };
  }

  // POST /wallet/charge — validate envelope → gateway posture → credit + ledger + notify.
  async function chargeWallet(command) {
    const gate = paymentValidationPolicy(command.amount);
    if (!gate.allowed) return { ok: false, code: gate.code };

    if (!paymentGateway.isEnabled()) return { ok: false, code: CommerceError.GATEWAY_UNAVAILABLE };

    const user = await walletRepository.getUser(command.phone);
    if (!user) return { ok: false, code: CommerceError.USER_NOT_FOUND };

    const balanceBefore = user.balance;
    await walletRepository.addBalance(command.phone, command.amount);
    const after = await walletRepository.getBalance(command.phone);
    const balanceAfter = after ? after.balance : balanceBefore + Number(command.amount);

    await ledgerRepository.logTransaction(
      command.phone,
      TransactionType.DEPOSIT,
      Number(command.amount),
      balanceBefore,
      balanceAfter,
      `شحن رصيد عبر ${command.method || 'غير محدد'}`,
      null,
      'completed'
    );

    await notificationGateway.send(
      command.phone,
      '💰 تم شحن رصيدك',
      `تمت إضافة ${command.amount} د.ك - رصيدك الحالي: ${balanceAfter.toFixed(3)} د.ك`,
      'wallet_charge'
    );

    await auditRepository.record('WALLET_CHARGE', {
      phone: command.phone,
      amount: Number(command.amount),
      balanceAfter,
    });

    // `amount` echoed raw (legacy interpolates the request value verbatim).
    return { ok: true, value: { balance: balanceAfter, amount: command.amount } };
  }

  // GET /wallet/transactions/:phone — ownership → ledger history + balance.
  async function getWalletTransactions(command) {
    if (!ownershipPolicy(command.paramPhone, command.authPhone).allowed) {
      return { ok: false, code: CommerceError.FORBIDDEN };
    }
    const transactions = await ledgerRepository.getTransactions(command.authPhone, 50);
    const row = await walletRepository.getBalance(command.authPhone);
    return { ok: true, value: { balance: (row && row.balance) || 0, transactions } };
  }

  // GET /wallet/balance/:phone — ownership → balance (404 if the user has none).
  async function getWalletBalance(command) {
    if (!ownershipPolicy(command.paramPhone, command.authPhone).allowed) {
      return { ok: false, code: CommerceError.FORBIDDEN };
    }
    const row = await walletRepository.getBalance(command.authPhone);
    if (!row) return { ok: false, code: CommerceError.BALANCE_NOT_FOUND };
    return { ok: true, value: { balance: row.balance } };
  }

  return { getPaymentMethods, chargeWallet, getWalletTransactions, getWalletBalance };
}

module.exports = { createCommerceUseCases, CommerceError };
