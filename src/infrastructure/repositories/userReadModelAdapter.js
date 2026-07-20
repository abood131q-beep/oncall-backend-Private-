'use strict';

/**
 * User read-model adapter — Infrastructure layer (ADR-004 §read models).
 * Implements the readModel port with READ-ONLY projections only. This is the
 * boundary that lets the Users context expose Balance and Activity WITHOUT
 * importing Wallet write logic (charge/deduct/transaction mutation) — those
 * remain a separate bounded context, out of scope this phase.
 *
 * Delegates to the existing WalletRepository read methods; introduces no new
 * SQL. All persistence knowledge stays behind this boundary.
 *
 * @param {object} deps — the existing DI service container
 */
function createUserReadModelAdapter(deps) {
  const { walletRepo } = deps;

  return {
    // User Balance (Read Only) — { balance } | undefined.
    getBalance: (phone) => walletRepo.getBalance(phone),

    // User Activity (Read Only) — the transaction ledger projection.
    getActivity: (phone, limit) => walletRepo.getTransactions(phone, limit),
  };
}

module.exports = { createUserReadModelAdapter };
