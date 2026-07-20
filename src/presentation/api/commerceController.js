'use strict';

/**
 * Commerce controller — Presentation layer.
 * HTTP translation only; ZERO business logic (ADR-005 §4). Every outcome is a
 * typed result from the application; this file maps it to the frozen response
 * contract (status, JSON shape, key order, Arabic messages must remain
 * byte-identical to the legacy payment router). Proven by the live A/B harness.
 *
 * GLOBALIZATION (ADR-003, non-breaking): Arabic is the frozen default; English
 * is additive via `Accept-Language: en` and never alters Arabic output.
 */

const { CommerceError } = require('../../application/commerce/useCases');

// Presentation-layer constant mirroring the frozen wallet-charge envelope
// (Domain owns the rule; this is only the display copy — no Domain import here).
const MAX_CHARGE = 500;

const ar = Object.freeze({
  [CommerceError.BAD_AMOUNT]: `المبلغ يجب أن يكون بين 0.001 و ${MAX_CHARGE} د.ك`,
  [CommerceError.GATEWAY_UNAVAILABLE]:
    'خدمة الدفع غير متاحة حالياً — بوابة الدفع غير مُهيَّأة في بيئة التطوير.',
  [CommerceError.USER_NOT_FOUND]: 'المستخدم غير موجود',
  [CommerceError.FORBIDDEN]: 'غير مصرح',
});
const en = Object.freeze({
  [CommerceError.BAD_AMOUNT]: `Amount must be between 0.001 and ${MAX_CHARGE} KWD`,
  [CommerceError.GATEWAY_UNAVAILABLE]:
    'Payment service is currently unavailable — the payment gateway is not configured in development.',
  [CommerceError.USER_NOT_FOUND]: 'User not found',
  [CommerceError.FORBIDDEN]: 'Not authorized',
});
function isEn(req) {
  return String(req.headers['accept-language'] || '')
    .toLowerCase()
    .startsWith('en');
}
function msg(req, code) {
  return isEn(req) ? en[code] || code : ar[code] || code;
}
const BARE = { success: false };

function createCommerceController(commerceApp) {
  const { useCases, commands } = commerceApp;

  return {
    // GET /payment/methods — no auth, no try/catch in legacy (pure catalog).
    async getPaymentMethods(req, res) {
      const r = await useCases.getPaymentMethods();
      res.json({ success: true, methods: r.value.methods });
    },

    // POST /wallet/charge
    async chargeWallet(req, res) {
      try {
        const b = req.body || {};
        const r = await useCases.chargeWallet(
          commands.chargeCommand({ phone: req.user.phone, amount: b.amount, method: b.method })
            .command
        );
        if (!r.ok) {
          if (r.code === CommerceError.BAD_AMOUNT) {
            return res.status(400).json({ success: false, message: msg(req, r.code) });
          }
          if (r.code === CommerceError.GATEWAY_UNAVAILABLE) {
            return res.status(503).json({
              success: false,
              message: msg(req, r.code),
              code: 'PAYMENT_GATEWAY_UNAVAILABLE',
            });
          }
          if (r.code === CommerceError.USER_NOT_FOUND) {
            return res.status(404).json({ success: false, message: msg(req, r.code) });
          }
          return res.status(500).json(BARE);
        }
        const amount = r.value.amount;
        const message = isEn(req) ? `Added ${amount} KWD` : `تم إضافة ${amount} د.ك`;
        res.json({ success: true, balance: r.value.balance, message });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /wallet/transactions/:phone
    async getWalletTransactions(req, res) {
      try {
        const r = await useCases.getWalletTransactions(
          commands.walletQueryCommand({
            paramPhone: req.params.phone,
            authPhone: req.user.phone,
          }).command
        );
        if (!r.ok) return res.status(403).json({ success: false, message: msg(req, r.code) });
        res.json({ success: true, balance: r.value.balance, transactions: r.value.transactions });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },

    // GET /wallet/balance/:phone
    async getWalletBalance(req, res) {
      try {
        const r = await useCases.getWalletBalance(
          commands.walletQueryCommand({
            paramPhone: req.params.phone,
            authPhone: req.user.phone,
          }).command
        );
        if (!r.ok) {
          // IDOR → 403 (with message); missing balance → 404 (bare, legacy contract).
          if (r.code === CommerceError.FORBIDDEN) {
            return res.status(403).json({ success: false, message: msg(req, r.code) });
          }
          return res.status(404).json(BARE);
        }
        res.json({ success: true, balance: r.value.balance });
      } catch (err) {
        res.status(500).json(BARE);
      }
    },
  };
}

module.exports = { createCommerceController };
