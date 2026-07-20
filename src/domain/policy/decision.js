'use strict';

/**
 * Decision engine (Phase 14.6 / ADR-025 §3) — PURE domain, DETERMINISTIC.
 * Evaluates a set of policies against a request context and returns a decision
 * with a full explanation. NO I/O, no clock.
 *
 * Guarantees:
 *   • Default deny — no applicable policy ⇒ deny.
 *   • Ordered — policies sorted by priority DESC, then policyId ASC (stable).
 *   • Conflict resolution — strategy ∈ deny-overrides (default) | allow-overrides
 *     | first-applicable | priority.
 *   • Short-circuit — where the strategy allows a definitive early decision.
 *   • Composition — `all`/`any`/`not` condition trees (see condition.js).
 */

const { EFFECT } = require('./policy');

const STRATEGY = Object.freeze({
  DENY_OVERRIDES: 'deny-overrides',
  ALLOW_OVERRIDES: 'allow-overrides',
  FIRST_APPLICABLE: 'first-applicable',
  PRIORITY: 'priority',
});

function _ordered(policies) {
  return policies
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || (a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0)
    );
}

/**
 * @param {object[]} policies policy entities
 * @param {object} request { scope, ...context }
 * @param {object} [opts] { strategy }
 * @returns {{ decision:'allow'|'deny', allowed:boolean, reason:string,
 *            decidingPolicy:object|null, evaluated:object[] }}
 */
function evaluate(policies, request = {}, opts = {}) {
  const strategy = opts.strategy || STRATEGY.DENY_OVERRIDES;
  const scope = request.scope;
  const ordered = _ordered(policies.filter((p) => p.isEnabled() && p.appliesToScope(scope)));

  const evaluated = [];
  let firstAllow = null;
  let firstDeny = null;

  for (const p of ordered) {
    let applicable = false;
    let error = null;
    try {
      applicable = p.matches(request);
    } catch (e) {
      error = e.message; // a throwing condition is treated as non-applicable (fail-safe)
    }
    evaluated.push({ policyId: p.policyId, name: p.name, effect: p.effect, applicable, error });
    if (!applicable) continue;

    if (strategy === STRATEGY.FIRST_APPLICABLE || strategy === STRATEGY.PRIORITY) {
      // Highest-priority applicable decides (list is already priority-ordered).
      return _result(p.effect, p, `${strategy}: ${p.name}`, evaluated);
    }
    if (p.effect === EFFECT.DENY && !firstDeny) firstDeny = p;
    if (p.effect === EFFECT.ALLOW && !firstAllow) firstAllow = p;

    if (strategy === STRATEGY.DENY_OVERRIDES && firstDeny) {
      return _result(EFFECT.DENY, firstDeny, `deny-overrides: ${firstDeny.name}`, evaluated);
    }
    if (strategy === STRATEGY.ALLOW_OVERRIDES && firstAllow) {
      return _result(EFFECT.ALLOW, firstAllow, `allow-overrides: ${firstAllow.name}`, evaluated);
    }
  }

  // No definitive override fired.
  if (strategy === STRATEGY.DENY_OVERRIDES && firstAllow) {
    return _result(EFFECT.ALLOW, firstAllow, `allow: ${firstAllow.name}`, evaluated);
  }
  if (strategy === STRATEGY.ALLOW_OVERRIDES && firstDeny) {
    return _result(EFFECT.DENY, firstDeny, `deny: ${firstDeny.name}`, evaluated);
  }
  return _result(EFFECT.DENY, null, 'default-deny', evaluated);
}

function _result(effect, decidingPolicy, reason, evaluated) {
  return {
    decision: effect,
    allowed: effect === EFFECT.ALLOW,
    reason,
    decidingPolicy: decidingPolicy ? decidingPolicy.toModel() : null,
    evaluated,
  };
}

module.exports = { evaluate, STRATEGY };
