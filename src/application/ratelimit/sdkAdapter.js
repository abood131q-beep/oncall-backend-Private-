'use strict';

/**
 * SDK ↔ Rate Limiting adapter (Phase 15.2 / ADR-031 §7/§9). Gives an Extension a
 * granted, namespace-isolated Rate Limiting port WITHOUT leaking engine internals
 * or the ability to author/reset policies. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot read or evaluate against another
 *     extension's policies/counters.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — evaluate/consume require `rate:evaluate`; verify/list require
 *     `rate:read`. Missing capability → PermissionError.
 *   • Policy authoring (registerPolicy) and reset are NOT exposed — they are
 *     administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toRateLimitPort(
  ratelimit,
  { owner, canRead = true, canEvaluate = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toRateLimitPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "rate:read"`);
  };
  const requireEvaluate = () => {
    if (!canEvaluate) {
      throw new PermissionError(`extension "${owner}" lacks capability "rate:evaluate"`);
    }
  };

  return {
    evaluate(spec = {}) {
      requireEvaluate();
      return ratelimit.evaluate(spec, { namespace });
    },
    consume(spec = {}) {
      requireEvaluate();
      return ratelimit.consume(spec, { namespace });
    },
    verify() {
      requireRead();
      return ratelimit.verify({ namespace });
    },
    list() {
      requireRead();
      return ratelimit.list({ namespace });
    },
    health() {
      return ratelimit.health();
    },
  };
}

module.exports = { toRateLimitPort };
