'use strict';

/**
 * readThroughShadow.js — Shared generic READ-THROUGH shadow verifier (G1.0 §7 generalization).
 *
 * Complements `createRoundTripShadow` (for kernels you feed & read back). This one is for the
 * **keyed read-through** pattern: for each key, read the legacy value AND the kernel value and
 * compare, always returning the legacy value. Configuration (17.3) uses it; future keyed
 * kernels (e.g. Identity `verify`, Policy `decide`) can reuse it.
 *
 * The caller injects the kernel-specific bits (readers, presence checks, and a `describe`
 * builder that owns redaction shape), so this module owns ONLY the control flow, metrics, and
 * coverage — no kernel knowledge, no duplicated `deepEqual`/metrics.
 *
 * Guarantees (G1.0 §1): `compareKey`/`verifyAll` never throw to the caller, never block, never
 * mutate app/persistent state; on kernel/adapter error they record a verification failure and
 * return the legacy value. When disabled or not consuming, they perform NO kernel interaction.
 */

const { deepEqual, createShadowMetrics } = require('./core');

/**
 * @param {object} deps
 * @param {string}   deps.name
 * @param {object}   deps.adapter   the only kernel seam ({ consumed() })
 * @param {object}   deps.legacy    Source of Truth ({ keys() })
 * @param {Function} deps.readLegacy (key) => value            (authoritative)
 * @param {Function} deps.readKernel (key) => value            (may throw)
 * @param {Function} [deps.legacyHas] (key) => boolean         (presence parity)
 * @param {Function} [deps.kernelHas] (key) => boolean
 * @param {Function} deps.describe  (key, legacyValue, kernelValue, extra) => descriptor
 *                                  (redaction shape owned by the caller)
 * @param {boolean|Function} [deps.enabled]
 * @param {object}   [deps.metrics]
 * @param {object}   [deps.logger]
 */
function createReadThroughShadow(deps = {}) {
  const { name = 'read-through-shadow', adapter, legacy, readLegacy, readKernel } = deps;
  const legacyHas = deps.legacyHas;
  const kernelHas = deps.kernelHas;
  const describe = deps.describe || ((key) => ({ key }));
  const metrics = deps.metrics || createShadowMetrics();
  const log = deps.logger || { warn() {}, info() {}, error() {} };
  const isEnabled = typeof deps.enabled === 'function' ? deps.enabled : () => Boolean(deps.enabled);

  if (!adapter || typeof adapter.consumed !== 'function') {
    throw new Error(`${name}: an adapter with consumed() is required`);
  }
  if (typeof readLegacy !== 'function' || typeof readKernel !== 'function') {
    throw new Error(`${name}: readLegacy(key) and readKernel(key) are required`);
  }

  /** Compare one key; ALWAYS return the legacy value. */
  function compareKey(key) {
    metrics.recordRequest();
    const legacyValue = readLegacy(key);
    if (!isEnabled() || !adapter.consumed()) return legacyValue;

    const t0 = Date.now();
    let kernelValue;
    try {
      kernelValue = readKernel(key);
    } catch (e) {
      metrics.recordVerificationFailure(
        describe(key, legacyValue, undefined, { error: e.message })
      );
      log.warn(`${name}: kernel read failed; legacy value returned`, { key, error: e.message });
      return legacyValue; // never throw; legacy always wins
    }
    const latencyMs = Date.now() - t0;

    let lh = true;
    let kh = false;
    try {
      lh = legacyHas ? Boolean(legacyHas(key)) : true;
    } catch {
      /* best-effort */
    }
    try {
      kh = kernelHas ? Boolean(kernelHas(key)) : false;
    } catch {
      /* treated as absent */
    }

    const matched = lh === kh && deepEqual(legacyValue, kernelValue);
    metrics.recordComparison(matched, latencyMs, key); // key ⇒ coverage
    if (!matched) {
      metrics.recordMismatch(
        describe(key, legacyValue, kernelValue, { legacyHas: lh, kernelHas: kh })
      );
    }
    return legacyValue; // ← authoritative, unconditional
  }

  /** Verify a set of keys (default: all legacy keys). Returns a report; never throws. */
  function verifyAll(keys) {
    const target = Array.isArray(keys) ? keys : legacy.keys();
    metrics.setDeclaredSurface(target.length);
    const before = metrics.snapshot();
    for (const key of target) compareKey(key);
    const after = metrics.snapshot();

    const comparisons = after.comparisons - before.comparisons;
    const matches = after.matches - before.matches;
    const mismatches = after.mismatches - before.mismatches;
    const verificationFailures = after.verificationFailures - before.verificationFailures;
    const parityPct = comparisons > 0 ? Math.round((matches / comparisons) * 100000) / 1000 : 100;

    return {
      enabled: isEnabled() && adapter.consumed(),
      keysChecked: target.length,
      comparisons,
      matches,
      mismatches,
      verificationFailures,
      parityPct,
      confidenceLevel: after.confidenceLevel,
      coveragePct: after.coveragePct,
      mismatchKeys: after.mismatches_log.slice(-Math.max(mismatches, 0)).map((m) => m.key),
    };
  }

  return Object.freeze({
    name,
    enabled: () => isEnabled() && adapter.consumed(),
    compareKey,
    verifyAll,
    stats: () => metrics.snapshot(),
    metrics,
  });
}

module.exports = { createReadThroughShadow };
