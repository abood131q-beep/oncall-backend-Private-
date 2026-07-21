'use strict';

/**
 * Mesh policy evaluation (Phase 15.8 / ADR-037 §3) — PURE domain, deterministic.
 * Given a connection + an invocation context, decide whether the call is admitted
 * (security policy incl. mutual identity) and how it routes (routing policy). No
 * I/O, no clock. Traffic-concurrency limits are enforced by the engine (it holds
 * the in-flight counters); this module owns the admission + routing decision.
 */

/** Mutual identity + security admission. Returns { allowed, reason? }. */
function evaluateSecurity(connection, context = {}) {
  const sp = connection.securityPolicy || {};
  const source = context.sourceService != null ? context.sourceService : connection.sourceService;
  if (sp.requireIdentity && !context.identity) {
    return { allowed: false, reason: 'identity_required' };
  }
  if (Array.isArray(sp.allowedSources) && sp.allowedSources.length > 0) {
    if (!sp.allowedSources.includes(source))
      return { allowed: false, reason: 'source_not_allowed' };
  }
  if (sp.mtls && context.secure === false) {
    return { allowed: false, reason: 'mtls_required' };
  }
  return { allowed: true };
}

/** Deterministic routing decision from the routing policy. */
function evaluateRouting(connection) {
  const rp = connection.routingPolicy || {};
  return {
    destination: connection.destinationService,
    strategy: rp.strategy || 'direct',
    subset: rp.subset != null ? rp.subset : null,
  };
}

/** Full evaluation: security admission then routing. Returns { allowed, reason?, route }. */
function evaluatePolicies(connection, context = {}) {
  const sec = evaluateSecurity(connection, context);
  if (!sec.allowed) return { allowed: false, reason: sec.reason, route: null };
  return { allowed: true, route: evaluateRouting(connection) };
}

module.exports = { evaluatePolicies, evaluateSecurity, evaluateRouting };
