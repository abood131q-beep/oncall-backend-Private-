'use strict';

/**
 * _base.js — shared helpers for the Platform Adapter Layer (Phase 17.2).
 *
 * Adapters are TRANSLATION LAYERS ONLY:
 *   • They contain NO business logic.
 *   • They NEVER access repositories, the database, or application services directly.
 *   • They communicate ONLY through an injected Enterprise public port (`port`).
 *   • In Phase 17.2 NO kernel is consumed: every adapter is constructed WITHOUT a port
 *     (`port = null`) and is therefore INERT. Active methods refuse to run until a future
 *     phase injects the corresponding kernel's public service as `port`.
 *
 * This keeps the seam in place (and unit-tested) while guaranteeing zero behavior change.
 */

class AdapterNotWiredError extends Error {
  constructor(name) {
    super(
      `platform-adapter "${name}": not wired in Phase 17.2 — no Enterprise kernel is ` +
        'consumed yet. Inject the kernel public service as `port` in the phase that ' +
        'adopts it.'
    );
    this.name = 'AdapterNotWiredError';
    this.code = 'ADAPTER_NOT_WIRED';
  }
}

/** Guard an active (kernel-consuming) method: returns the port or throws if not wired. */
function requirePort(name, port) {
  if (port == null) throw new AdapterNotWiredError(name);
  return port;
}

module.exports = { AdapterNotWiredError, requirePort };
