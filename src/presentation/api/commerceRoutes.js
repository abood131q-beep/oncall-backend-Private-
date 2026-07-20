'use strict';

/**
 * Commerce routes — Presentation layer (Enterprise Architecture Migration Phase 11).
 *
 * Strangler cutover for the Commerce bounded context (Wallet + Payments). The
 * four Commerce endpoints lived in the legacy payment router; this router now
 * OWNS them. It is mounted BEFORE the legacy payment router, so first-match makes
 * it the sole active owner. COMMERCE_LEGACY=1 removes it (see server.js) and the
 * still-mounted legacy payment handlers resume serving those paths — immediate
 * rollback. Paths, middleware, status codes, JSON shapes, key order, and Arabic
 * messages are byte-identical to legacy — proven by tests/integration/commerce-ab.mjs.
 *
 * SCOPE (frozen): the pre-existing Commerce HTTP surface only —
 *   GET  /payment/methods            (payment-method catalog)
 *   POST /wallet/charge              (wallet top-up, gated by PAYMENT_ENABLED)
 *   GET  /wallet/transactions/:phone (wallet history + balance, IDOR-guarded)
 *   GET  /wallet/balance/:phone      (balance query, IDOR-guarded)
 * The trip-settlement path (`PaymentService.processPayment`) is REUSED in place by
 * the Trips completion gateway inside the ADR-001 serialized transaction — not
 * rewired here. `/fare/*` in the legacy payment router is pricing, not Commerce,
 * and stays there. No new financial capability is introduced; no new provider.
 *
 * Composition root: framework/adapter wiring is confined here. The atomic
 * WalletRepository, the ledger, the PAYMENT_ENABLED gateway posture, and the
 * notifier are REUSED via adapters, never reimplemented.
 */

const express = require('express');
const { PAYMENT_ENABLED } = require('../../config/env');

const { createCommerceApplication } = require('../../application/commerce');
const {
  createCommerceWalletRepository,
  createCommerceLedgerRepository,
} = require('../../infrastructure/repositories/commerceRepositoryAdapter');
const {
  createCommercePaymentGateway,
  createCommerceNotificationGateway,
  createCommerceAuditRepository,
} = require('../../infrastructure/gateways/commerceGateways');
const { createCommerceController } = require('./commerceController');

function createCommerceRouter(services) {
  const deps = { ...services, PAYMENT_ENABLED };

  const app = createCommerceApplication({
    walletRepository: createCommerceWalletRepository(deps),
    ledgerRepository: createCommerceLedgerRepository(deps),
    paymentGateway: createCommercePaymentGateway(deps),
    notificationGateway: createCommerceNotificationGateway(deps),
    auditRepository: createCommerceAuditRepository(deps),
  });

  const c = createCommerceController(app);
  const router = express.Router();
  const { authenticate } = services;

  router.get('/payment/methods', c.getPaymentMethods);
  router.post('/wallet/charge', authenticate, c.chargeWallet);
  router.get('/wallet/transactions/:phone', authenticate, c.getWalletTransactions);
  router.get('/wallet/balance/:phone', authenticate, c.getWalletBalance);

  return router;
}

module.exports = { createCommerceRouter };
