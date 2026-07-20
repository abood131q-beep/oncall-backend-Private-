'use strict';

/**
 * Scooter gateways — Infrastructure layer.
 * Adapters over EXISTING legacy integrations (reused, never replaced):
 *  - walletGateway       → WalletRepository (Wallet context is NOT migrated)
 *  - notificationGateway → NotificationRepository
 *  - fleetGateway        → the legacy reset side-effect (taxis → online)
 *  - scooterCache        → the in-process cache service
 *
 * @param {object} deps — the existing DI service container
 */

function createScooterWalletGateway(deps) {
  const { walletRepo } = deps;
  return {
    getBalance: (phone) => walletRepo.getBalance(phone),
    // Best-effort charge, byte-identical to legacy end-ride: atomic deduct,
    // and only on success append the transaction fact (append-only ledger).
    async charge(phone, amount, description) {
      const deduct = await walletRepo.deductBalanceSafe(phone, amount);
      const newBalance = deduct.balanceAfter ?? 0;
      if (deduct.success) {
        const balanceBefore = newBalance + amount;
        await walletRepo.logTransaction(
          phone,
          'scooter_payment',
          amount,
          balanceBefore,
          newBalance,
          description
        );
      }
      return { charged: deduct.success, newBalance };
    },
  };
}

function createScooterNotificationGateway(deps) {
  const { notifRepo } = deps;
  return {
    send: (phone, title, body, type) => notifRepo.send(phone, title, body, type),
  };
}

function createScooterFleetGateway(deps) {
  const { dbRun } = deps;
  return {
    // Preserves the exact legacy reset side-effect (taxis back online).
    bringTaxisOnline: () => dbRun("UPDATE taxis SET status = 'online'"),
  };
}

function createScooterCacheAdapter(deps) {
  const { getCache, setCache, clearCache } = deps;
  return {
    get: (key) => getCache(key),
    set: (key, value, ttl) => setCache(key, value, ttl),
    clear: (key) => clearCache(key),
  };
}

module.exports = {
  createScooterWalletGateway,
  createScooterNotificationGateway,
  createScooterFleetGateway,
  createScooterCacheAdapter,
};
