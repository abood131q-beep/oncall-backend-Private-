'use strict';

/**
 * Configuration Adapter — Phase 17.3.
 *
 * The ONLY component permitted to talk to the Configuration Kernel (ADR-019). It is a pure
 * TRANSLATION layer between the application-facing shape and the kernel's public service
 * (`get / exists / list / version / snapshot`). It contains NO business logic and never
 * touches repositories, the database, or application services.
 *
 * SHADOW POSTURE: even when a kernel port is injected (PLATFORM_CONFIG=1), this adapter is
 * READ-ONLY and NON-AUTHORITATIVE. The values it reads are used only by the shadow verifier
 * to compare against the legacy source; they are NEVER returned to the application. Legacy
 * configuration (env.js) always wins.
 */

const { requirePort } = require('../_base');

function createConfigurationAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'configuration',
    kernel: 'config (ADR-019)',
    consumed: () => port != null,

    // ── pure translation (shape-only, no side effects) ──────────────────────────
    toKey: (key) => String(key),
    fromEntry: (entry) => (entry && 'value' in entry ? entry.value : undefined),

    // ── active reads (require an injected Configuration kernel port) ─────────────
    // Mapped to the kernel service's REAL method names (has → exists). Read-only.
    get: (key) => requirePort('configuration', port).get(String(key)),
    has: (key) => requirePort('configuration', port).exists(String(key)),
    list: (prefix) => requirePort('configuration', port).list(prefix),
    version: () => requirePort('configuration', port).version(),
    /** Raw (un-redacted) snapshot values — used ONLY by the shadow comparator. */
    snapshotValues: () => requirePort('configuration', port).snapshot({ redact: false }).values,

    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createConfigurationAdapter };
