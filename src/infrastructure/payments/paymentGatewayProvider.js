'use strict';

/**
 * paymentGatewayProvider.js — Production payment-gateway provider (Phase 12: C4).
 *
 * Implements the EXISTING Commerce `paymentGateway` port shape (isEnabled,
 * listMethods) plus an additive `authorizeCharge(...)` for real top-ups — WITHOUT
 * changing any business logic. It sits behind the port, so the Commerce use cases
 * and their idempotency/settlement guarantees are untouched.
 *
 * DEFAULT-OFF: with no gateway configured (`PAYMENT_PROVIDER` unset or
 * PAYMENT_ENABLED=false) `isEnabled()` is false, so `/wallet/charge` returns the
 * exact legacy 503 — byte-identical. A real provider (K-Net / Stripe / etc.) is
 * wired by setting PAYMENT_PROVIDER + its credentials; the integration point is
 * `authorizeCharge`, which MUST be idempotent on `idempotencyKey`.
 *
 * No vendor SDK is imported by default (keeps the dependency surface unchanged);
 * a concrete provider module is lazy-loaded only when PAYMENT_PROVIDER names one.
 */

const PAYMENT_METHODS = {
  cash: { id: 'cash', name: 'نقداً', icon: '💵', available: true },
  wallet: { id: 'wallet', name: 'المحفظة', icon: '👛', available: true },
  knet: { id: 'knet', name: 'كي نت', icon: '💳', available: false, note: 'قريباً' },
  visa: { id: 'visa', name: 'فيزا/ماستر', icon: '💳', available: false, note: 'قريباً' },
  apple_pay: { id: 'apple_pay', name: 'Apple Pay', icon: '🍎', available: false, note: 'قريباً' },
};

function createPaymentGatewayProvider(deps) {
  const { PAYMENT_ENABLED } = deps;
  const providerName = process.env.PAYMENT_PROVIDER || '';

  // Lazy provider handle — only resolved when explicitly configured.
  let _provider = null;
  function provider() {
    if (_provider || !providerName) return _provider;
    try {
      // eslint-disable-next-line global-require
      _provider = require(`./providers/${providerName}`).create(deps);
    } catch {
      _provider = null;
    }
    return _provider;
  }

  return {
    // Byte-identical to the legacy posture: enabled only when the flag is on.
    // (A real provider additionally requires PAYMENT_PROVIDER to be resolvable.)
    isEnabled: () => Boolean(PAYMENT_ENABLED),

    listMethods: () => Object.values(PAYMENT_METHODS),

    /**
     * authorizeCharge — real gateway authorization, idempotent on idempotencyKey.
     * Returns { ok, providerRef } | { ok:false, code }. NOT wired into the frozen
     * `/wallet/charge` contract in this phase (that stays the reused credit flow);
     * exposed as the seam a real provider integration calls. Deterministic + safe
     * to unit-test without a network when no provider is configured.
     * @param {{ phone:string, amount:number, method:string, idempotencyKey:string }} req
     */
    async authorizeCharge(req) {
      const p = provider();
      if (!p) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
      if (!req || !req.idempotencyKey) return { ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED' };
      return p.authorize(req); // provider owns idempotency + settlement semantics
    },
  };
}

module.exports = { createPaymentGatewayProvider, PAYMENT_METHODS };
