'use strict';

/**
 * legacySource.js — Phase 17.3.
 *
 * A thin, read-only view over the LEGACY configuration (env.js) — the single Source of Truth.
 * It exposes the exact typed values env.js already computed (numbers, booleans, arrays,
 * objects), so the shadow verifier can compare them against the Configuration Kernel WITHOUT
 * changing env.js or how the application reads configuration.
 *
 * The env exports are injectable for testing; by default it reads the real module. This
 * module performs NO parsing of its own — env.js remains the sole owner of parsing/defaults.
 */

/**
 * @param {object} [options]
 * @param {object} [options.exports] the env.js exports object (typed values). Defaults to the
 *   real `src/config/env` module.
 */
function createLegacyConfigSource({ exports: envExports } = {}) {
  // eslint-disable-next-line global-require
  const values = envExports || require('../../config/env');
  const keys = Object.keys(values);

  return Object.freeze({
    source: 'legacy:env.js',
    /** All configuration keys the legacy system defines. */
    keys: () => [...keys],
    /** Whether the legacy system defines this key. */
    has: (key) => Object.prototype.hasOwnProperty.call(values, key),
    /** The legacy (authoritative) value for a key. */
    get: (key) => values[key],
    /** A shallow snapshot of all legacy values (used to seed the kernel identically). */
    snapshot: () => ({ ...values }),
  });
}

module.exports = { createLegacyConfigSource };
