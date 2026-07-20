'use strict';

/**
 * AI / Automation domain — Value Objects (ADR-002 §4, ADR-011).
 * Pure vocabulary for the platform's intelligence surface. No SDK, no HTTP
 * client, no framework, no I/O. Encodes ONLY what already exists: the ADR-011
 * decision classification (§4) and the deterministic automation "embryos" the
 * platform already runs (matching, rule-based fare, auto-rollback — ADR-011 §1).
 * No model, vendor, or new capability is introduced.
 */

/** Decision classes — who may decide (ADR-011 §4). */
const DecisionClass = Object.freeze({
  D1: 'D1', // human-only
  D2: 'D2', // AI-assisted human
  D3: 'D3', // automated-reversible, within envelope, human-overridable
  D4: 'D4', // automated-consequential (rare, board-approved)
});

/** Routing outcome for an intelligent decision (ADR-011 §4 escalation path). */
const DecisionRoute = Object.freeze({
  ACT: 'act', // act on the model output (within envelope, confidence ≥ floor)
  FALLBACK: 'fallback', // use the deterministic fallback (ADR-011 §8)
  ESCALATE: 'escalate', // route to a human queue (degrade to D2)
});

/** Where a response came from (ADR-011 §8 — fallback is a tested mode). */
const ResponseSource = Object.freeze({
  MODEL: 'model',
  FALLBACK: 'fallback',
});

/** Provider kinds — the platform runs only deterministic engines today. */
const ProviderKind = Object.freeze({
  DETERMINISTIC: 'deterministic', // rule-based engines (matcher, fare, rollback)
  MODEL: 'model', // an inference provider (none configured today)
});

const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;
const DEFAULT_CONFIDENCE_FLOOR = 0.7;
const MAX_PROMPT_LENGTH = 8000;

/**
 * AUTOMATION_REGISTRY — the intelligent/automated decision kinds the platform
 * ALREADY runs, each with its ADR-011 class, its owning context, and its
 * mandatory deterministic fallback (ADR-011 §8). This is a classification of
 * existing reality, not a new capability.
 */
const AUTOMATION_REGISTRY = Object.freeze({
  dispatch_matching: Object.freeze({
    kind: 'dispatch_matching',
    decisionClass: DecisionClass.D3,
    owner: 'trips',
    fallback: 'rule_based_matcher', // the existing driverMatcher service
  }),
  fare_estimation: Object.freeze({
    kind: 'fare_estimation',
    decisionClass: DecisionClass.D3,
    owner: 'trips',
    fallback: 'authored_base_rules', // the existing fareCalculator (rule-based)
  }),
  auto_rollback: Object.freeze({
    kind: 'auto_rollback',
    decisionClass: DecisionClass.D3,
    owner: 'platform',
    fallback: 'manual_rollback', // human-initiated rollback
  }),
});

/** Provider VO — normalize a provider descriptor without asserting reachability. */
function Provider({ name, kind, enabled } = {}) {
  return Object.freeze({
    name: name || null,
    kind: kind === ProviderKind.MODEL ? ProviderKind.MODEL : ProviderKind.DETERMINISTIC,
    enabled: Boolean(enabled),
  });
}

/** Prompt VO — normalize prompt text (trim); validity is the policy's concern. */
function Prompt(text) {
  return Object.freeze({ text: text == null ? '' : String(text).trim() });
}

/** AIRequest VO — an intelligence request bound to a registered decision kind. */
function AIRequest({ kind, input, decisionClass, confidenceFloor } = {}) {
  return Object.freeze({
    kind: kind || null,
    input: input == null ? null : input,
    decisionClass: decisionClass || null,
    confidenceFloor:
      typeof confidenceFloor === 'number' ? confidenceFloor : DEFAULT_CONFIDENCE_FLOOR,
  });
}

/** AIResponse VO — a normalized intelligence response (may be a fallback). */
function AIResponse({ value, confidence, source, explanation } = {}) {
  return Object.freeze({
    value: value == null ? null : value,
    confidence: typeof confidence === 'number' ? confidence : null,
    source: source === ResponseSource.MODEL ? ResponseSource.MODEL : ResponseSource.FALLBACK,
    explanation: explanation || null,
  });
}

function isRegisteredKind(kind) {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_REGISTRY, kind);
}

module.exports = {
  DecisionClass,
  DecisionRoute,
  ResponseSource,
  ProviderKind,
  CONFIDENCE_MIN,
  CONFIDENCE_MAX,
  DEFAULT_CONFIDENCE_FLOOR,
  MAX_PROMPT_LENGTH,
  AUTOMATION_REGISTRY,
  Provider,
  Prompt,
  AIRequest,
  AIResponse,
  isRegisteredKind,
};
