'use strict';

/**
 * Commerce repository adapters — Infrastructure layer.
 * Implement walletRepository + ledgerRepository by REUSING the existing atomic
 * `WalletRepository` (source of truth: `users.balance`) and the `transactions`
 * ledger, plus `userRepo` for the account lookup. Every call delegates to the
 * proven legacy repository — no SQL is rewritten here, so the atomic-deduct and
 * bookkeeping guarantees (C-1 / ADR-001) are preserved exactly.
 *
 * @param {object} deps — the existing DI service container
 */

function createCommerceWalletRepository(deps) {
  const { walletRepo, userRepo } = deps;
  return {
    getUser: (phone) => userRepo.findByPhone(phone),
    getBalance: (phone) => walletRepo.getBalance(phone),
    addBalance: (phone, amount) => walletRepo.addBalance(phone, amount),
    deductBalanceSafe: (phone, amount) => walletRepo.deductBalanceSafe(phone, amount),
  };
}

function createCommerceLedgerRepository(deps) {
  const { walletRepo } = deps;
  return {
    logTransaction: (phone, type, amount, before, after, description, tripId, status) =>
      walletRepo.logTransaction(phone, type, amount, before, after, description, tripId, status),
    getTransactions: (phone, limit) => walletRepo.getTransactions(phone, limit),
  };
}

module.exports = { createCommerceWalletRepository, createCommerceLedgerRepository };
