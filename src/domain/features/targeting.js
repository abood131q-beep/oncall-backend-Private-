'use strict';

/**
 * Targeting matchers (Phase 15.0 / ADR-029 §3) — PURE domain. Deterministic,
 * side-effect-free predicates the evaluation engine composes. A `null`/`undefined`
 * constraint means "no constraint" (matches anything), so a flag targets broadly
 * by default and narrows only where a constraint is declared.
 */

const semver = require('../extensions/semver');

/**
 * Scalar/array membership match:
 *   constraint == null           → true (unconstrained)
 *   Array                        → context value ∈ constraint
 *   scalar                       → context value === constraint
 */
function matchValue(contextValue, constraint) {
  if (constraint == null) return true;
  if (Array.isArray(constraint)) {
    if (constraint.length === 0) return true;
    return constraint.includes(contextValue);
  }
  return contextValue === constraint;
}

/**
 * Version match: constraint is a semver range (or array of ranges — any match).
 *   null/undefined → true. Invalid context version → false (unless unconstrained).
 */
function matchVersion(contextVersion, constraint) {
  if (constraint == null) return true;
  if (contextVersion == null) return false;
  const ranges = Array.isArray(constraint) ? constraint : [constraint];
  if (ranges.length === 0) return true;
  return ranges.some((r) => semver.satisfies(String(contextVersion), String(r)));
}

/**
 * AND-composition of a conditions object `{ attr: constraint }` against a context.
 * Every declared condition must match. `appVersion` is matched as a semver range;
 * everything else as scalar/array membership.
 */
function matchConditions(context = {}, conditions = {}) {
  for (const [attr, constraint] of Object.entries(conditions || {})) {
    const ok =
      attr === 'appVersion' || attr === 'version'
        ? matchVersion(context[attr] != null ? context[attr] : context.appVersion, constraint)
        : matchValue(context[attr], constraint);
    if (!ok) return false;
  }
  return true;
}

/**
 * Flag-level targeting constraints: platform / country / region / tenant /
 * environment / appVersion (each optional). Returns { ok, failed? } so the engine
 * can explain WHY a context was not targeted.
 */
function matchFlagConstraints(context = {}, flag = {}) {
  const checks = [
    ['platform', matchValue(context.platform, flag.platform)],
    ['country', matchValue(context.country, flag.country)],
    ['region', matchValue(context.region, flag.region)],
    ['tenant', matchValue(context.tenant, flag.tenant)],
    ['environment', matchValue(context.environment, flag.environment)],
    ['appVersion', matchVersion(context.appVersion, flag.appVersion)],
  ];
  for (const [name, ok] of checks) {
    if (!ok) return { ok: false, failed: name };
  }
  // Additional named targeting attributes (object of attr → constraint).
  if (flag.targeting && !matchConditions(context, flag.targeting)) {
    return { ok: false, failed: 'targeting' };
  }
  return { ok: true };
}

module.exports = { matchValue, matchVersion, matchConditions, matchFlagConstraints };
