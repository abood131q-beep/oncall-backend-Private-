'use strict';

/**
 * AI / Automation domain — Policies (ADR-002 §5, ADR-005 §1, ADR-011 §2/§4/§8).
 * The invariants of intelligent participation; the Application asks, this module
 * decides. Pure: no I/O, no SDK, no HTTP, no framework. Every rule is a direct
 * encoding of an ADR-011 principle — it constrains how intelligence may act, it
 * never itself performs inference or introduces a capability.
 */

const {
  DecisionClass,
  DecisionRoute,
  ResponseSource,
  ProviderKind,
  CONFIDENCE_MIN,
  CONFIDENCE_MAX,
  MAX_PROMPT_LENGTH,
} = require('./aiValues');

const AIRejection = Object.freeze({
  EMPTY_PROMPT: 'EMPTY_PROMPT',
  PROMPT_TOO_LONG: 'PROMPT_TOO_LONG',
  UNSAFE_AUTOMATION: 'UNSAFE_AUTOMATION',
  UNKNOWN_DECISION: 'UNKNOWN_DECISION',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
});

/**
 * ProviderSelectionPolicy (ADR-011 §8) — pick an enabled MODEL provider for the
 * request; if none is enabled the decision routes to the deterministic fallback.
 * Today no model provider is configured, so this always yields a fallback — the
 * platform's real posture.
 */
function providerSelectionPolicy(providers) {
  const usable = (Array.isArray(providers) ? providers : []).find(
    (p) => p && p.enabled && p.kind === ProviderKind.MODEL
  );
  return usable
    ? { provider: usable }
    : { fallback: true, reason: AIRejection.PROVIDER_UNAVAILABLE };
}

/**
 * PromptValidationPolicy — a prompt must be non-empty and within the length
 * envelope. Pure input hygiene (no content inference).
 */
function promptValidationPolicy(prompt) {
  const text = prompt && typeof prompt.text === 'string' ? prompt.text : '';
  if (!text) return { allowed: false, code: AIRejection.EMPTY_PROMPT };
  if (text.length > MAX_PROMPT_LENGTH) return { allowed: false, code: AIRejection.PROMPT_TOO_LONG };
  return { allowed: true, prompt: { text } };
}

/**
 * AISafetyPolicy (ADR-011 §2.3/§2.8) — governance & human-only (D1) decisions
 * may never be automated by AI; the safety path works with all intelligence off.
 * This is an independent guard OUTSIDE any model (ADR-011 §8).
 */
function aiSafetyPolicy(request) {
  if (!request || request.decisionClass === DecisionClass.D1) {
    return { allowed: false, code: AIRejection.UNSAFE_AUTOMATION };
  }
  return { allowed: true };
}

/**
 * AIRoutingPolicy (ADR-011 §4) — decide how an intelligent output is used:
 *  - no model response / provider unavailable       → deterministic FALLBACK
 *  - confidence below the per-decision floor         → D4 ESCALATE, else FALLBACK
 *  - within envelope & class permits automation      → ACT
 * Low confidence is a routing signal, never a warning on an action taken anyway.
 */
function aiRoutingPolicy(request, response) {
  const floor = request ? request.confidenceFloor : 1;
  const cls = request ? request.decisionClass : null;

  const noModelOutput =
    !response ||
    response.source !== ResponseSource.MODEL ||
    typeof response.confidence !== 'number';
  if (noModelOutput) return { route: DecisionRoute.FALLBACK, source: ResponseSource.FALLBACK };

  const clamped = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, response.confidence));
  if (clamped < floor) {
    return cls === DecisionClass.D4
      ? { route: DecisionRoute.ESCALATE, source: ResponseSource.FALLBACK }
      : { route: DecisionRoute.FALLBACK, source: ResponseSource.FALLBACK };
  }
  // D2 is assist-only: a model output still informs a human, never acts alone.
  if (cls === DecisionClass.D2)
    return { route: DecisionRoute.ESCALATE, source: ResponseSource.MODEL };
  return { route: DecisionRoute.ACT, source: ResponseSource.MODEL };
}

/**
 * AIAuditPolicy (ADR-011 §4) — the audit record every AI-influenced decision
 * must carry: decision kind/class, confidence, resulting route/source, the
 * acting authority, the envelope-check result, and an explanation summary. Pure
 * shape; the timestamp/persistence is the infrastructure's concern.
 */
function aiAuditPolicy({ request, response, routing }) {
  return {
    kind: request ? request.kind : null,
    decisionClass: request ? request.decisionClass : null,
    confidence: response ? response.confidence : null,
    route: routing ? routing.route : null,
    source: routing ? routing.source : null,
    authority:
      routing && routing.route === DecisionRoute.ACT
        ? 'machine_within_envelope'
        : 'deterministic_or_human',
    envelopeOk: Boolean(routing && routing.route !== DecisionRoute.ESCALATE),
    explanation: response ? response.explanation : null,
  };
}

module.exports = {
  AIRejection,
  providerSelectionPolicy,
  promptValidationPolicy,
  aiSafetyPolicy,
  aiRoutingPolicy,
  aiAuditPolicy,
};
