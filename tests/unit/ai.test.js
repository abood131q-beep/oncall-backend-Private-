'use strict';

/**
 * AI / Automation slice tests — proves the migrated Domain + Application layers
 * encode the ADR-011 decision architecture faithfully, with pure fakes (no SDK,
 * no HTTP, no framework). Because the platform runs NO model provider today,
 * every routed decision must resolve to its deterministic fallback and never
 * call a provider — that invariant is what these tests lock in. Covers the value
 * objects, the five policies, the capability aggregate, and the four use cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DecisionClass,
  DecisionRoute,
  ResponseSource,
  ProviderKind,
  AUTOMATION_REGISTRY,
  Provider,
  Prompt,
  AIRequest,
  AIResponse,
  isRegisteredKind,
} = require('../../src/domain/ai/aiValues');
const {
  providerSelectionPolicy,
  promptValidationPolicy,
  aiSafetyPolicy,
  aiRoutingPolicy,
  aiAuditPolicy,
  AIRejection,
} = require('../../src/domain/ai/aiPolicies');
const { reconstituteCapability, listCapabilities } = require('../../src/domain/ai/AI');
const { createAIApplication, AIError } = require('../../src/application/ai');

// ── Domain: value objects + registry ─────────────────────────────────────────

test('AUTOMATION_REGISTRY classifies the existing automations as D3 with fallbacks', () => {
  assert.equal(AUTOMATION_REGISTRY.dispatch_matching.decisionClass, DecisionClass.D3);
  assert.equal(AUTOMATION_REGISTRY.dispatch_matching.fallback, 'rule_based_matcher');
  assert.equal(AUTOMATION_REGISTRY.fare_estimation.fallback, 'authored_base_rules');
  assert.equal(AUTOMATION_REGISTRY.auto_rollback.fallback, 'manual_rollback');
  assert.equal(isRegisteredKind('dispatch_matching'), true);
  assert.equal(isRegisteredKind('speculative_agent'), false);
  assert.equal(listCapabilities().length, 3);
});

test('VOs normalize their inputs and default safely', () => {
  assert.deepEqual(Provider({ name: 'x', kind: 'model', enabled: true }), {
    name: 'x',
    kind: ProviderKind.MODEL,
    enabled: true,
  });
  assert.equal(Provider({ kind: 'weird' }).kind, ProviderKind.DETERMINISTIC);
  assert.deepEqual(Prompt('  hi  '), { text: 'hi' });
  assert.equal(Prompt(null).text, '');
  assert.equal(AIRequest({ kind: 'k' }).confidenceFloor, 0.7);
  assert.equal(AIResponse({ value: 1 }).source, ResponseSource.FALLBACK);
});

// ── Domain: policies ─────────────────────────────────────────────────────────

test('providerSelectionPolicy falls back when no enabled MODEL provider exists', () => {
  assert.equal(providerSelectionPolicy([]).fallback, true);
  assert.equal(providerSelectionPolicy([{ enabled: false, kind: 'model' }]).fallback, true);
  assert.equal(providerSelectionPolicy([{ enabled: true, kind: 'deterministic' }]).fallback, true);
  const ok = providerSelectionPolicy([{ name: 'm', enabled: true, kind: 'model' }]);
  assert.equal(ok.provider.name, 'm');
});

test('promptValidationPolicy rejects empty and oversized prompts', () => {
  assert.equal(promptValidationPolicy(Prompt('')).code, AIRejection.EMPTY_PROMPT);
  assert.equal(promptValidationPolicy(Prompt('x'.repeat(8001))).code, AIRejection.PROMPT_TOO_LONG);
  assert.deepEqual(promptValidationPolicy(Prompt(' ok ')), {
    allowed: true,
    prompt: { text: 'ok' },
  });
});

test('aiSafetyPolicy forbids automating D1 (human-only) decisions', () => {
  assert.equal(
    aiSafetyPolicy(AIRequest({ kind: 'k', decisionClass: 'D1' })).code,
    AIRejection.UNSAFE_AUTOMATION
  );
  assert.equal(aiSafetyPolicy(null).code, AIRejection.UNSAFE_AUTOMATION);
  assert.equal(aiSafetyPolicy(AIRequest({ kind: 'k', decisionClass: 'D3' })).allowed, true);
});

test('aiRoutingPolicy: no model output ⇒ fallback; low confidence ⇒ fallback/escalate; ok ⇒ act', () => {
  const d3 = AIRequest({ kind: 'k', decisionClass: 'D3', confidenceFloor: 0.7 });
  // no model output → deterministic fallback
  assert.deepEqual(aiRoutingPolicy(d3, null), {
    route: DecisionRoute.FALLBACK,
    source: ResponseSource.FALLBACK,
  });
  // model output but below floor → fallback (D3)
  const low = AIResponse({ value: 1, confidence: 0.5, source: 'model' });
  assert.equal(aiRoutingPolicy(d3, low).route, DecisionRoute.FALLBACK);
  // D4 below floor → escalate
  const d4 = AIRequest({ kind: 'k', decisionClass: 'D4', confidenceFloor: 0.7 });
  assert.equal(aiRoutingPolicy(d4, low).route, DecisionRoute.ESCALATE);
  // above floor, D3 → act
  const high = AIResponse({ value: 1, confidence: 0.9, source: 'model' });
  assert.equal(aiRoutingPolicy(d3, high).route, DecisionRoute.ACT);
  // above floor, D2 → escalate (assist-only)
  const d2 = AIRequest({ kind: 'k', decisionClass: 'D2', confidenceFloor: 0.7 });
  assert.equal(aiRoutingPolicy(d2, high).route, DecisionRoute.ESCALATE);
});

test('aiAuditPolicy records the ADR-011 §4 decision fields', () => {
  const request = AIRequest({ kind: 'fare_estimation', decisionClass: 'D3' });
  const routing = { route: DecisionRoute.FALLBACK, source: ResponseSource.FALLBACK };
  const rec = aiAuditPolicy({ request, response: null, routing });
  assert.equal(rec.kind, 'fare_estimation');
  assert.equal(rec.decisionClass, 'D3');
  assert.equal(rec.authority, 'deterministic_or_human');
  assert.equal(rec.envelopeOk, true);
});

// ── Domain: aggregate ────────────────────────────────────────────────────────

test('reconstituteCapability.decide gates D1, forces fallback when provider absent', () => {
  assert.equal(reconstituteCapability('nope'), null);
  const cap = reconstituteCapability('dispatch_matching');
  const req = cap.request({ pickup: 'x' }, 0.7);
  // even with a "confident" model response, no enabled provider ⇒ fallback
  const resp = AIResponse({ value: 'driverX', confidence: 0.99, source: 'model' });
  const decision = cap.decide(req, resp, []);
  assert.equal(decision.allowed, true);
  assert.equal(decision.usedFallback, true);
  assert.equal(decision.routing.route, DecisionRoute.FALLBACK);
});

// ── Application: orchestration over pure fakes ───────────────────────────────

function makeApp(overrides = {}) {
  const base = {
    aiProvider: {
      isConfigured: () => false,
      infer: async () => {
        throw new Error('should not be called');
      },
    },
    promptRepository: { get: async () => null },
    aiConfigurationRepository: {
      getConfig: async () => ({ enabled: false, providers: [], defaultConfidenceFloor: 0.7 }),
    },
    aiAuditRepository: { record: async () => ({ recorded: true }) },
  };
  return createAIApplication({ ...base, ...overrides });
}

test('assertPorts fails fast when an AI port method is missing', () => {
  assert.throws(() => makeApp({ aiAuditRepository: {} }), /aiAuditRepository/);
});

test('describeCapabilities reports the disabled posture + the owned inventory', async () => {
  const { useCases } = makeApp();
  const r = await useCases.describeCapabilities();
  assert.equal(r.value.enabled, false);
  assert.equal(r.value.providerConfigured, false);
  assert.equal(r.value.capabilities.length, 3);
});

test('classifyDecision maps known kinds, rejects unknown', async () => {
  const { useCases, commands } = makeApp();
  const ok = await useCases.classifyDecision(
    commands.classifyCommand({ kind: 'auto_rollback' }).command
  );
  assert.equal(ok.value.decisionClass, 'D3');
  const bad = await useCases.classifyDecision(commands.classifyCommand({ kind: 'ghost' }).command);
  assert.equal(bad.code, AIError.UNKNOWN_DECISION);
});

test('route resolves to fallback, records audit, and never calls the provider', async () => {
  let recorded = null;
  let inferCalled = false;
  const app = makeApp({
    aiProvider: {
      isConfigured: () => false,
      infer: async () => {
        inferCalled = true;
        return null;
      },
    },
    aiAuditRepository: {
      record: async (e) => {
        recorded = e;
        return { recorded: true };
      },
    },
  });
  const r = await app.useCases.route(
    app.commands.routeCommand({ kind: 'fare_estimation', input: { km: 5 } }).command
  );
  assert.deepEqual(r.value, { route: 'fallback', source: 'fallback', usedFallback: true });
  assert.equal(inferCalled, false);
  assert.equal(recorded.kind, 'fare_estimation');
  const bad = await app.useCases.route(app.commands.routeCommand({ kind: 'ghost' }).command);
  assert.equal(bad.code, AIError.UNKNOWN_DECISION);
});

test('getPrompt is null-safe (no authored templates today)', async () => {
  const { useCases, commands } = makeApp();
  const r = await useCases.getPrompt(commands.promptCommand({ name: 'welcome' }).command);
  assert.deepEqual(r.value, { name: 'welcome', prompt: null });
});
