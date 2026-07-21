'use strict';

/**
 * SDK ↔ Observability adapter (Phase 15.4 / ADR-033 §7/§9). Gives an Extension a
 * granted, namespace-isolated Observability port WITHOUT leaking engine internals
 * or another extension's telemetry. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only report/read its own components.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — register/collect/snapshot require `observability:read`;
 *     diagnostics/verify require `observability:diagnostics`. Missing capability →
 *     PermissionError.
 *   • Diagnostic redaction is applied by the engine, so a granted diagnostics view
 *     still never exposes sensitive metadata.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toObservabilityPort(
  observability,
  { owner, canRead = true, canDiagnostics = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toObservabilityPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) {
      throw new PermissionError(`extension "${owner}" lacks capability "observability:read"`);
    }
  };
  const requireDiagnostics = () => {
    if (!canDiagnostics) {
      throw new PermissionError(
        `extension "${owner}" lacks capability "observability:diagnostics"`
      );
    }
  };

  return {
    register(spec = {}) {
      requireRead();
      return observability.register(spec, { namespace });
    },
    collect(spec = {}) {
      requireRead();
      return observability.collect(spec, { namespace });
    },
    snapshot() {
      requireRead();
      return observability.snapshot({ namespace });
    },
    diagnostics(opts = {}) {
      requireDiagnostics();
      return observability.diagnostics({ ...opts, namespace });
    },
    verify() {
      requireDiagnostics();
      return observability.verify({ namespace });
    },
    health() {
      return observability.health();
    },
  };
}

module.exports = { toObservabilityPort };
