'use strict';

/**
 * SDK ↔ Feature Flag adapter (Phase 15.0 / ADR-029 §7/§9). Gives an Extension a
 * granted, namespace-isolated Feature Flag port WITHOUT leaking engine internals
 * or the ability to mutate flags. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot read or evaluate another extension's
 *     flags.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — evaluate requires `feature:evaluate`; list/verify/health require
 *     `feature:read`. Missing capability → PermissionError.
 *   • Read-only surface — register/enable/disable/update are NOT exposed to
 *     extensions; flag authoring is an administrative operation.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toFeaturePort(
  features,
  { owner, canRead = true, canEvaluate = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toFeaturePort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "feature:read"`);
  };
  const requireEvaluate = () => {
    if (!canEvaluate) {
      throw new PermissionError(`extension "${owner}" lacks capability "feature:evaluate"`);
    }
  };

  return {
    evaluate(spec = {}) {
      requireEvaluate();
      return features.evaluate(spec, { namespace });
    },
    list() {
      requireRead();
      return features.list({ namespace });
    },
    verify() {
      requireRead();
      return features.verify({ namespace });
    },
    health() {
      return features.health();
    },
  };
}

module.exports = { toFeaturePort };
