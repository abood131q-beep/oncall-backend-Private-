'use strict';

/**
 * SDK ↔ Resilience adapter (Phase 15.7 / ADR-036 §7/§9). Gives an Extension a
 * granted, namespace-isolated Resilience port WITHOUT leaking engine internals or
 * the ability to author/reset policies. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only execute/evaluate its own policies.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — execute requires `resilience:execute`; evaluate/verify require
 *     `resilience:read`. Missing capability → PermissionError.
 *   • Policy authoring (registerPolicy) and reset are NOT exposed — they are
 *     administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toResiliencePort(
  resilience,
  { owner, canExecute = true, canRead = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toResiliencePort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireExecute = () => {
    if (!canExecute) {
      throw new PermissionError(`extension "${owner}" lacks capability "resilience:execute"`);
    }
  };
  const requireRead = () => {
    if (!canRead) {
      throw new PermissionError(`extension "${owner}" lacks capability "resilience:read"`);
    }
  };

  return {
    execute(spec = {}) {
      requireExecute();
      return resilience.execute(spec, { namespace });
    },
    evaluate(spec = {}) {
      requireRead();
      return resilience.evaluate(spec, { namespace });
    },
    verify() {
      requireRead();
      return resilience.verify({ namespace });
    },
    health() {
      return resilience.health();
    },
  };
}

module.exports = { toResiliencePort };
