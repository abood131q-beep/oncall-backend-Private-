'use strict';

/**
 * SDK ↔ Policy adapter (Phase 14.6 / ADR-025 §8/§9). Gives an Extension a
 * granted, namespace-isolated Policy port WITHOUT leaking engine internals.
 * Security:
 *   • Namespace isolation — every request/registration is forced into the
 *     extension's own namespace (`ext.<owner>`); it cannot read or evaluate
 *     another extension's policies.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — register/enable/disable require `policy:read` (authoring);
 *     evaluate/explain require `policy:evaluate`; list requires `policy:read`.
 *     Missing capability → PermissionError.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toPolicyPort(
  policy,
  { owner, canRead = true, canEvaluate = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toPolicyPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "policy:read"`);
  };
  const requireEvaluate = () => {
    if (!canEvaluate)
      throw new PermissionError(`extension "${owner}" lacks capability "policy:evaluate"`);
  };
  const scoped = (spec = {}) => ({ ...spec, namespace });

  return {
    register(spec) {
      requireRead();
      return policy.register(scoped(spec));
    },
    evaluate(request, opts) {
      requireEvaluate();
      return policy.evaluate(scoped(request), opts);
    },
    explain(request, opts) {
      requireEvaluate();
      return policy.explain(scoped(request), opts);
    },
    enable(policyId) {
      requireRead();
      return policy.enable(namespace, policyId);
    },
    disable(policyId) {
      requireRead();
      return policy.disable(namespace, policyId);
    },
    list(spec) {
      requireRead();
      return policy.list(scoped(spec));
    },
    health() {
      return policy.health();
    },
  };
}

module.exports = { toPolicyPort };
