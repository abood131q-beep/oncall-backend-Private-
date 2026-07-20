'use strict';

/**
 * sandbox (Phase 14.2 §4) — builds the ONLY surface an extension may touch.
 * Default posture is deny-all: an extension receives a frozen context exposing
 * exactly the host ports whose permission is BOTH declared in its manifest AND
 * granted by the host. Repositories, DB, filesystem, secrets, and network are
 * unreachable unless a matching permission+port is granted.
 *
 * The host provides `portFactories`: { permission -> () => portObject }. A port
 * is materialized only when its permission is granted, so ungranted resources
 * are never even constructed for the extension.
 */

const { isKnownPermission } = require('../../domain/extensions/capabilities');

/**
 * @param {object} manifest validated manifest (has .permissions)
 * @param {object} portFactories { [permission]: () => port }
 * @param {object} [opts] { logger }
 * @returns {{ context: Readonly<object>, granted: string[], has(perm):bool }}
 */
function createSandbox(manifest, portFactories = {}, opts = {}) {
  const log = opts.logger || { warn() {} };
  const grantedSet = new Set();
  const context = {};

  for (const perm of manifest.permissions) {
    if (!isKnownPermission(perm)) {
      // manifest validation already rejects these; belt-and-suspenders here.
      log.warn && log.warn(`sandbox: ignoring unknown permission "${perm}"`);
      continue;
    }
    const factory = portFactories[perm];
    if (typeof factory !== 'function') {
      // Declared but host did not grant/provide it → remains unreachable.
      continue;
    }
    // Materialize the port under a stable key = the permission name.
    context[perm] = factory();
    grantedSet.add(perm);
  }

  // Explicitly deny reach-through: freeze and provide an assert helper.
  const frozen = Object.freeze(context);

  return {
    context: frozen,
    granted: [...grantedSet],
    has: (perm) => grantedSet.has(perm),
    /** Throw unless the permission was granted (guards host-side capability calls). */
    require(perm) {
      if (!grantedSet.has(perm)) {
        throw new Error(`extension "${manifest.id}" lacks permission "${perm}"`);
      }
      return frozen[perm];
    },
  };
}

module.exports = { createSandbox };
