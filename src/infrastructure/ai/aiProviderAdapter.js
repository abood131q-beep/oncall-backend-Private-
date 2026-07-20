'use strict';

/**
 * AI provider adapter — Infrastructure layer.
 * Implements the aiProvider port. The platform runs NO inference provider today
 * (ADR-011 §1/§5/§10: intelligence enters after the substrate stabilizes and
 * ADR-001 is resolved). This adapter therefore honestly reports the disabled
 * posture — `isConfigured()` is false and `infer()` refuses — so every routed
 * decision resolves to its deterministic fallback (ADR-011 §8). It intentionally
 * imports no SDK and opens no socket; wiring a real provider is a future,
 * separately-governed capability, not this ownership phase.
 *
 * @param {object} deps — the existing DI service container (unused today)
 */

// eslint-disable-next-line no-unused-vars
function createAIProviderAdapter(deps) {
  return {
    // No model provider is configured in the platform today.
    isConfigured: () => false,

    // Never invoked while disabled; refuses loudly if ever called out of contract.
    async infer() {
      throw new Error('AI provider not configured');
    },
  };
}

module.exports = { createAIProviderAdapter };
