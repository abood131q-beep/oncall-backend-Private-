'use strict';

/**
 * Commerce ports — capability contracts the Application depends on (ADR-005 §2).
 * Infrastructure implements. Every existing payment integration is REUSED behind
 * these ports (the atomic `WalletRepository`, the transactions ledger, the
 * `PAYMENT_ENABLED` gateway posture, the notification sender, the logger audit),
 * never reimplemented. No new financial integration is introduced.
 *
 * walletRepository:     getUser, getBalance, addBalance, deductBalanceSafe
 * ledgerRepository:     logTransaction, getTransactions   (the transactions table)
 * paymentGateway:       isEnabled, listMethods            (PAYMENT_ENABLED + methods)
 * notificationGateway:  send                              (reused notifRepo)
 * auditRepository:      record                            (reused logger)
 */

const PORT_SHAPES = {
  walletRepository: ['getUser', 'getBalance', 'addBalance', 'deductBalanceSafe'],
  ledgerRepository: ['logTransaction', 'getTransactions'],
  paymentGateway: ['isEnabled', 'listMethods'],
  notificationGateway: ['send'],
  auditRepository: ['record'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Commerce ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Commerce ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
