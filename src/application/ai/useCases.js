'use strict';

/**
 * AI / Automation use cases — Application layer (ADR-005 §5/§6, ADR-011).
 * Validation → authorization (safety) → provider selection → domain execution →
 * typed result. These orchestrate the OWNERSHIP of existing automations; they
 * perform NO inference while no model provider is enabled (ADR-011 §8: the
 * deterministic fallback is the tested default). Persistence/audit are reused
 * behind ports, never reimplemented.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 */

const { reconstituteCapability, listCapabilities } = require('../../domain/ai/AI');
const { isRegisteredKind } = require('../../domain/ai/aiValues');
const { AIRejection } = require('../../domain/ai/aiPolicies');

const AIError = Object.freeze({ ...AIRejection });

function createAIUseCases(ports) {
  const { aiProvider, promptRepository, aiConfigurationRepository, aiAuditRepository } = ports;

  // Read model: the inventory of owned automation capabilities + their classes.
  async function describeCapabilities() {
    const config = await aiConfigurationRepository.getConfig();
    return {
      ok: true,
      value: {
        enabled: Boolean(config && config.enabled),
        providerConfigured: aiProvider.isConfigured(),
        capabilities: listCapabilities(),
      },
    };
  }

  // Classify an existing decision kind under the ADR-011 §4 taxonomy.
  async function classifyDecision(command) {
    if (!isRegisteredKind(command.kind)) return { ok: false, code: AIError.UNKNOWN_DECISION };
    const cap = reconstituteCapability(command.kind);
    return {
      ok: true,
      value: {
        kind: cap.kind,
        decisionClass: cap.decisionClass,
        owner: cap.owner,
        fallback: cap.fallback,
      },
    };
  }

  // Route an intelligence request through safety → selection → routing → audit.
  // With no model provider enabled, this deterministically resolves to fallback
  // (or escalate for D4) and never calls a provider — the platform's real posture.
  async function route(command) {
    if (!isRegisteredKind(command.kind)) return { ok: false, code: AIError.UNKNOWN_DECISION };
    const cap = reconstituteCapability(command.kind);
    const request = cap.request(command.input, command.confidenceFloor);

    const config = await aiConfigurationRepository.getConfig();
    const providers = (config && config.providers) || [];

    // Only consult a provider when one is actually enabled (never today).
    let response = null;
    if (aiProvider.isConfigured() && providers.some((p) => p.enabled && p.kind === 'model')) {
      response = await aiProvider.infer(request);
    }

    const decision = cap.decide(request, response, providers);
    if (!decision.allowed) return { ok: false, code: decision.code };

    await aiAuditRepository.record(decision.audit);
    return {
      ok: true,
      value: {
        route: decision.routing.route,
        source: decision.routing.source,
        usedFallback: decision.usedFallback,
      },
    };
  }

  // Authored prompt templates (none authored today → null-safe).
  async function getPrompt(command) {
    const prompt = await promptRepository.get(command.name);
    return { ok: true, value: { name: command.name, prompt: prompt || null } };
  }

  return { describeCapabilities, classifyDecision, route, getPrompt };
}

module.exports = { createAIUseCases, AIError };
