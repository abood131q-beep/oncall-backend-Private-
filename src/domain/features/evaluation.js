'use strict';

/**
 * Evaluation engine (Phase 15.0 / ADR-029 §3) — PURE domain. Deterministic
 * feature evaluation with a full explanation. Given the SAME flag definition and
 * the SAME context, it ALWAYS returns the SAME result — no randomness, no clock.
 *
 * Order (highest precedence first):
 *   1. archived / disabled           → off value
 *   2. flag targeting constraints    → off value if the context is not targeted
 *   3. ordered rules (priority desc, then declared order) with optional per-rule
 *      rollout; first matching + included rule wins  (conflict resolution)
 *   4. flag-level percentage rollout  → default value if included, else off value
 *   5. fallthrough                    → default value
 */

const { matchConditions, matchFlagConstraints } = require('./targeting');
const { isIncluded, bucketOf, bucketingKey } = require('./rollout');

/** Stable subject id used for rollout bucketing. */
function subjectOf(context = {}, attribute) {
  if (attribute && context[attribute] != null) return String(context[attribute]);
  return String(
    context.key != null
      ? context.key
      : context.userId != null
        ? context.userId
        : context.identityId != null
          ? context.identityId
          : context.subject != null
            ? context.subject
            : 'anonymous'
  );
}

function rolloutExplain(flagName, roll, context) {
  const subject = subjectOf(context, roll.attribute);
  const key = bucketingKey(flagName, roll.salt, subject);
  return {
    percentage: roll.percentage,
    bucket: bucketOf(key),
    subject,
    included: isIncluded(key, roll.percentage),
  };
}

/**
 * @param {object} flag  a flag MODEL (plain object) or entity
 * @param {object} context evaluation attributes (platform, country, appVersion, key, …)
 * @returns {object} { value, reason, served, targeted, ruleId?, rollout?, failed? }
 */
function evaluateFlag(flag, context = {}) {
  const off = flag.offValue;

  if (flag.state === 'archived') {
    return { value: off, reason: 'archived', served: false, targeted: false };
  }
  if (flag.state !== 'enabled') {
    return { value: off, reason: 'disabled', served: false, targeted: false };
  }

  const targeting = matchFlagConstraints(context, flag);
  if (!targeting.ok) {
    return {
      value: off,
      reason: 'not_targeted',
      served: false,
      targeted: false,
      failed: targeting.failed,
    };
  }

  // Ordered rules: priority desc, then declared order (stable) → conflict resolution.
  const ordered = (flag.rules || [])
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);

  for (const { rule } of ordered) {
    if (!matchConditions(context, rule.when)) continue;
    if (rule.rollout) {
      const roll = rolloutExplain(flag.name, rule.rollout, context);
      if (!roll.included) continue; // matched but excluded → try lower-precedence rules
      return {
        value: rule.value,
        reason: 'rule_match',
        served: true,
        targeted: true,
        ruleId: rule.id,
        rollout: roll,
      };
    }
    return {
      value: rule.value,
      reason: 'rule_match',
      served: true,
      targeted: true,
      ruleId: rule.id,
    };
  }

  if (flag.rollout) {
    const roll = rolloutExplain(flag.name, flag.rollout, context);
    return roll.included
      ? {
          value: flag.defaultValue,
          reason: 'rollout_included',
          served: true,
          targeted: true,
          rollout: roll,
        }
      : { value: off, reason: 'rollout_excluded', served: false, targeted: true, rollout: roll };
  }

  return { value: flag.defaultValue, reason: 'default', served: true, targeted: true };
}

module.exports = { evaluateFlag, subjectOf };
