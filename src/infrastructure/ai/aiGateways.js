'use strict';

/**
 * AI / Automation gateways — Infrastructure layer.
 * Implement promptRepository / aiConfigurationRepository / aiAuditRepository by
 * reusing EXISTING infrastructure only: configuration from the environment
 * (AI disabled today), the audit fabric from the existing structured `logger`
 * (ADR-007/ADR-010), and authored prompt templates (none exist today → null).
 * No new store, no schema change, no SDK.
 *
 * @param {object} deps — the existing DI service container
 */

function createPromptRepository() {
  return {
    // No authored prompt templates exist in the platform today.
    async get() {
      return null;
    },
  };
}

function createAIConfigurationRepository() {
  return {
    // AI is disabled until a provider is separately governed and enabled.
    // Read purely from the environment; no AI_* vars are set today.
    async getConfig() {
      return {
        enabled: process.env.AI_ENABLED === '1',
        providers: [], // no model providers configured
        defaultConfidenceFloor: 0.7,
      };
    },
  };
}

function createAIAuditRepository(deps) {
  const { logger } = deps;
  return {
    // Append AI-decision audit records to the existing security/audit fabric
    // (ADR-011 §4). Reuses the platform logger; introduces no new sink.
    async record(event) {
      if (logger && typeof logger.info === 'function') {
        logger.info('AI_DECISION', event);
      }
      return { recorded: true };
    },
  };
}

module.exports = {
  createPromptRepository,
  createAIConfigurationRepository,
  createAIAuditRepository,
};
