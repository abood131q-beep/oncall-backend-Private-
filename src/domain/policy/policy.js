'use strict';

/**
 * Policy (Phase 14.6 / ADR-025 §2) — PURE domain value object. A declarative
 * decision rule; the engine interprets it. NO business logic.
 *
 * Fields: policyId, name, version, namespace, scope, priority, condition,
 * effect (allow|deny), metadata, state (enabled|disabled), checksum.
 */

const { PolicyDefinitionError } = require('./errors');
const condition = require('./condition');
const { checksum } = require('../extensions/integrity');

const EFFECT = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });
const STATE = Object.freeze({ ENABLED: 'enabled', DISABLED: 'disabled' });

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `pol_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * @param {object} spec { name (required), scope (required), effect, condition?,
 *   priority?, namespace?, version?, metadata?, policyId?, state? }
 */
function createPolicy(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  if (!spec.name || typeof spec.name !== 'string') {
    throw new PolicyDefinitionError('policy: "name" is required');
  }
  if (!spec.scope || typeof spec.scope !== 'string') {
    throw new PolicyDefinitionError('policy: "scope" is required (e.g. "trip:create" or "*")');
  }
  const effect = spec.effect || EFFECT.DENY;
  if (effect !== EFFECT.ALLOW && effect !== EFFECT.DENY) {
    throw new PolicyDefinitionError(`policy: effect must be "allow" or "deny", got "${effect}"`);
  }
  try {
    condition.validate(spec.condition);
  } catch (e) {
    throw new PolicyDefinitionError(`policy "${spec.name}": ${e.message}`);
  }

  const core = {
    policyId: spec.policyId || idFactory(),
    name: spec.name,
    version: spec.version || 1,
    namespace: spec.namespace || 'default',
    scope: spec.scope,
    priority: typeof spec.priority === 'number' ? spec.priority : 0,
    effect,
    condition: spec.condition === undefined ? true : spec.condition,
    metadata: { ...(spec.metadata || {}) },
    state: spec.state === STATE.DISABLED ? STATE.DISABLED : STATE.ENABLED,
  };
  // Integrity checksum over the definitional fields (functions excluded).
  const integrity = checksum(
    JSON.stringify({
      policyId: core.policyId,
      name: core.name,
      version: core.version,
      namespace: core.namespace,
      scope: core.scope,
      priority: core.priority,
      effect: core.effect,
      metadata: core.metadata,
      condition: _stableCondition(core.condition),
    })
  );

  return {
    ...core,
    checksum: integrity,
    isEnabled() {
      return this.state === STATE.ENABLED;
    },
    appliesToScope(scope) {
      return this.scope === '*' || this.scope === scope;
    },
    matches(ctx) {
      return condition.evaluate(this.condition, ctx);
    },
    toModel() {
      return {
        policyId: this.policyId,
        name: this.name,
        version: this.version,
        namespace: this.namespace,
        scope: this.scope,
        priority: this.priority,
        effect: this.effect,
        state: this.state,
        metadata: { ...this.metadata },
        checksum: this.checksum,
      };
    },
  };
}

/** Stable, function-free view of a condition for checksum determinism. */
function _stableCondition(node) {
  if (node === true || node == null || typeof node !== 'object')
    return node === undefined ? true : node;
  if (Array.isArray(node.all)) return { all: node.all.map(_stableCondition) };
  if (Array.isArray(node.any)) return { any: node.any.map(_stableCondition) };
  if ('not' in node) return { not: _stableCondition(node.not) };
  if (typeof node.fn === 'function') return { fn: 'custom' };
  return node;
}

module.exports = { createPolicy, EFFECT, STATE };
