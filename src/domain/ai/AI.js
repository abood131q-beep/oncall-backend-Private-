'use strict';

/**
 * AI / Automation domain — Capability aggregate (ADR-002 §3, ADR-011 §3/§5).
 * A pure representation of one owned, registered automation capability (e.g.
 * dispatch matching). Holds no SDK/HTTP/framework. Its `decide` method composes
 * the safety → selection → routing → audit policies over a request/response, in
 * the ADR-011 sense→decide→act shape — but performs no inference itself (that is
 * the infrastructure provider's job, invoked by the Application only when a model
 * provider is enabled). No new capability beyond the registered decision kinds.
 */

const { AUTOMATION_REGISTRY, AIRequest, isRegisteredKind } = require('./aiValues');
const {
  aiSafetyPolicy,
  providerSelectionPolicy,
  aiRoutingPolicy,
  aiAuditPolicy,
} = require('./aiPolicies');

/** Reconstitute a capability from the registry (read side). */
function reconstituteCapability(kind) {
  if (!isRegisteredKind(kind)) return null;
  const spec = AUTOMATION_REGISTRY[kind];
  return Object.freeze({
    kind: spec.kind,
    decisionClass: spec.decisionClass,
    owner: spec.owner,
    fallback: spec.fallback,

    /** Build the bound request for this capability at a given confidence floor. */
    request(input, confidenceFloor) {
      return AIRequest({
        kind: spec.kind,
        input,
        decisionClass: spec.decisionClass,
        confidenceFloor,
      });
    },

    /**
     * Pure decision composition: safety gate → provider availability → routing →
     * audit record. `response` is null unless a model provider actually produced
     * one (never today). Returns { allowed, routing, audit } — no side effects.
     */
    decide(request, response, providers) {
      const safety = aiSafetyPolicy(request);
      if (!safety.allowed) return { allowed: false, code: safety.code };
      const selection = providerSelectionPolicy(providers);
      const effective = selection.fallback ? null : response;
      const routing = aiRoutingPolicy(request, effective);
      const audit = aiAuditPolicy({ request, response: effective, routing });
      return { allowed: true, routing, audit, usedFallback: Boolean(selection.fallback) };
    },
  });
}

/** The full inventory of owned automation capabilities (read model). */
function listCapabilities() {
  return Object.values(AUTOMATION_REGISTRY).map((s) => ({ ...s }));
}

module.exports = { reconstituteCapability, listCapabilities };
