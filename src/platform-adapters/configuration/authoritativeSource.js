'use strict';

/**
 * authoritativeSource.js — Phase 18.5 / ADR-048.
 *
 * The SYNCHRONOUS authoritative Configuration read source used when
 * `CONFIG_AUTHORITATIVE=1`. It builds the Configuration Kernel's resolved snapshot **once,
 * synchronously, at bootstrap** from the env.js seed, and serves reads from that frozen-shape
 * snapshot with no async dependency whatsoever.
 *
 * WHY THIS CAN BE SYNCHRONOUS (and is still "the kernel"):
 * The OnCall application configuration is **defaults-only** — env.js is the single seed, there
 * are NO asynchronous providers and NO schema wired (see enterprise/configShadow.js
 * `buildConfigSeed`, which seeds the kernel with `{ config: { defaults: seed } }` and nothing
 * else). For that shape, the Configuration Kernel's full pipeline
 * (providers → precedence.resolve → schema.validate → activate) reduces deterministically to a
 * single synchronous stage: `precedence.resolve({ default: seed })`. We invoke the kernel's OWN
 * domain resolution module (`domain/config/precedence`) to build the snapshot, so this is the
 * kernel's authoritative resolution — just without the async provider machinery that this
 * configuration does not use. The 17.3/18.0 shadow already PROVED, at 100% parity, that a kernel
 * seeded exactly this way returns byte-identical values to env.js.
 *
 * VALUE IDENTITY: the seed is a SHALLOW copy of env's export (`legacy.snapshot()` = `{...values}`),
 * so each resolved value is the **same reference** env.js holds. Reads therefore return the exact
 * same object/primitive env would — behavior is byte-identical, not merely deep-equal, and env's
 * existing (non-frozen) mutability characteristics are unchanged. We do NOT deep-freeze the value
 * objects (that would diverge from env's current behavior); only the snapshot container is frozen.
 *
 * FAIL-SAFE: construction is fully guarded by the caller. If building the snapshot throws for any
 * reason, the caller (the facade) treats this source as unavailable and falls back to env.js. A
 * built source that is not `ready()` must never be used.
 */

const precedence = require('../../domain/config/precedence');

/**
 * @param {object} deps
 * @param {{ snapshot: () => object }} deps.legacy legacy config source (env-backed)
 * @param {object} [deps.clock] () => ISO string
 * @returns a synchronous authoritative read source
 */
function createAuthoritativeConfigSource({ legacy, clock } = {}) {
  if (!legacy || typeof legacy.snapshot !== 'function') {
    throw new Error('authoritativeSource: a legacy config source is required');
  }
  const now = clock || (() => new Date().toISOString());

  // Build the kernel snapshot synchronously via the kernel's domain resolution.
  // Shallow seed → value references preserved (byte-identical reads vs env.js).
  const seed = legacy.snapshot(); // { ...env values }
  const { values, origins } = precedence.resolve({ default: seed });

  // Freeze ONLY the container maps, not the value objects (preserve env mutability semantics).
  const snapshot = Object.freeze({
    values, // key → same reference env holds
    origins: Object.freeze(origins),
    version: 1,
    at: now(),
  });

  // Integrity guard: the resolved key set must match the seed's (no key silently dropped).
  const seedKeys = Object.keys(seed);
  const snapKeys = Object.keys(snapshot.values);
  const intact = seedKeys.length === snapKeys.length && seedKeys.every((k) => k in snapshot.values);

  return Object.freeze({
    source: 'kernel:snapshot',
    /** Whether the snapshot built cleanly and is safe to serve. */
    ready: () => intact,
    has: (key) => Object.prototype.hasOwnProperty.call(snapshot.values, key),
    get: (key) => snapshot.values[key],
    keys: () => Object.keys(snapshot.values),
    version: () => snapshot.version,
    /** Raw resolved values (used by the A/B harness and diagnostics). */
    snapshotValues: () => snapshot.values,
    diagnostics: () => ({
      source: 'kernel:snapshot',
      ready: intact,
      version: snapshot.version,
      at: snapshot.at,
      keys: snapKeys.length,
    }),
  });
}

module.exports = { createAuthoritativeConfigSource };
