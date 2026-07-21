'use strict';

/**
 * index.js — Runtime Configuration Read Facade (Phase 18.3) + Authoritative path (Phase 18.5 / ADR-048).
 *
 * THE single, approved runtime configuration read seam for the entire application.
 *
 * TWO BACKINGS, one seam (selected by the `CONFIG_AUTHORITATIVE` flag, default OFF):
 *
 *   CONFIG_AUTHORITATIVE=0 (default)   config.get() → env.js                      [byte-identical to 18.4]
 *   CONFIG_AUTHORITATIVE=1             config.get() → Configuration Kernel snapshot → env.js fallback
 *
 * The kernel snapshot is built ONCE, SYNCHRONOUSLY, at facade load, from the env.js seed via the
 * kernel's own domain resolution (see platform-adapters/configuration/authoritativeSource.js).
 * There is NO async dependency in config.get(); no boot-order change (env still loads first).
 *
 * MANDATORY FALLBACK (fail-safe — never worse than legacy): under CONFIG_AUTHORITATIVE=1, if the
 * kernel source failed to build, is not ready, does not have the key, or throws on read, config.get
 * IMMEDIATELY returns the env.js value. The application never fails to start because of the kernel.
 * Rollback is flag-only: set CONFIG_AUTHORITATIVE=0.
 *
 * INVARIANT (ADR-046 / R8): application code MUST read configuration ONLY through this facade.
 * env.js remains the bootstrap source, the mandatory fallback, and the emergency recovery path.
 *
 * CONTRACT (unchanged): get(key[,fallback]) · require(key) · has(key) · keys() · all().
 * PROPERTIES: synchronous · deterministic · typed values preserved · env fail-fast preserved.
 */

const env = require('./env');

// ── Backing selection (default OFF ⇒ zero behavior change) ────────────────────────────────────
// Active authoritative source (kernel snapshot), or null when OFF / build failed ⇒ env fallback.
let authoritative = null;
let mode = 'legacy';
let flag = false;

/**
 * Build the authoritative kernel snapshot synchronously. Reads the CONFIG_AUTHORITATIVE flag from
 * the environment (production evaluates this once at module load). Fully guarded: ANY failure
 * leaves `authoritative = null` so the facade serves env.js (fail-safe). No throw escapes.
 */
function initAuthoritative() {
  authoritative = null;
  mode = 'legacy';
  flag = process.env.CONFIG_AUTHORITATIVE === '1';
  if (!flag) return;
  try {
    // eslint-disable-next-line global-require
    const { createLegacyConfigSource } = require('../platform-adapters/configuration/legacySource');
    // eslint-disable-next-line global-require
    const {
      createAuthoritativeConfigSource,
    } = require('../platform-adapters/configuration/authoritativeSource');
    const legacy = createLegacyConfigSource({ exports: env });
    const src = createAuthoritativeConfigSource({ legacy });
    if (src && src.ready()) {
      authoritative = src;
      mode = 'authoritative';
    }
  } catch {
    authoritative = null; // env fallback
    mode = 'legacy';
  }
}
initAuthoritative();

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/** @returns the typed value for `key`, or `fallback` (default undefined) when absent. */
function get(key, fallback) {
  if (authoritative) {
    try {
      if (authoritative.has(key)) return authoritative.get(key);
    } catch {
      /* fall through to env fallback */
    }
  }
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : fallback;
}

/** @returns the typed value for `key`, or THROWS if the key is defined in neither source. */
function requireKey(key) {
  if (authoritative) {
    try {
      if (authoritative.has(key)) return authoritative.get(key);
    } catch {
      /* fall through to env fallback */
    }
  }
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    throw new Error(`config: required key "${key}" is missing`);
  }
  return env[key];
}

/** @returns whether `key` is defined in the active source or env (fail-safe union). */
function has(key) {
  if (authoritative) {
    try {
      if (authoritative.has(key)) return true;
    } catch {
      /* fall through */
    }
  }
  return Object.prototype.hasOwnProperty.call(env, key);
}

/** @returns all defined configuration keys (union of active source + env — no key is ever lost). */
function keys() {
  if (!authoritative) return Object.keys(env);
  const set = new Set(Object.keys(env));
  try {
    for (const k of authoritative.keys()) set.add(k);
  } catch {
    /* env keys already included */
  }
  return [...set];
}

/** @returns a shallow copy of all values (debugging / bulk read; prefer get/require). */
function all() {
  if (!authoritative) return { ...env };
  try {
    return { ...env, ...authoritative.snapshotValues() };
  } catch {
    return { ...env };
  }
}

/** Introspection: current backing mode ('legacy' | 'authoritative'). */
function currentMode() {
  return mode;
}

/** Introspection: structured diagnostics of the config facade + active source. */
function diagnostics() {
  return {
    mode,
    flag,
    fallback: 'env.js',
    authoritative: authoritative ? authoritative.diagnostics() : null,
  };
}

module.exports = {
  get,
  require: requireKey,
  has,
  keys,
  all,
  mode: currentMode,
  diagnostics,
  // Backing source label: env.js (legacy) or kernel-snapshot (authoritative, env fallback).
  _source: () => (authoritative ? 'kernel-snapshot' : 'env.js'),
  // Test-only hook: rebuild the authoritative source after mutating process.env in-process.
  // Never called by application code.
  __reinit: initAuthoritative,
};
