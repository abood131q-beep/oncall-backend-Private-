'use strict';

/**
 * shadow.js — Observability Shadow Verifier (17.4; unified in 18.0 onto the shared framework).
 *
 *   Legacy Observability → Observability Adapter → Observability Kernel →
 *   Parity Verification → Shadow Metrics → RETURN LEGACY RESULT
 *
 * Uses the shared `deepEqual`/`flatten` and the shared `createShadowMetrics` (so it now emits
 * `coveragePct` alongside `confidenceLevel`, and no local comparator/metrics remain). Its own
 * compare loop is retained only because it ignores the volatile `event.componentId` leaf (the
 * kernel assigns fresh physical component ids), which the generic verifier does not model.
 *
 * Hard guarantees (unchanged): the kernel is NEVER authoritative — `shadowObserve()` always
 * returns the LEGACY observation; kernel values are never exposed; `verify()` never throws,
 * never blocks, never mutates runtime/health/metrics; disabled ⇒ no kernel interaction.
 */

const { deepEqual, flatten, createShadowMetrics } = require('../_shadow');

function createObservabilityShadow(deps = {}) {
  const adapter = deps.adapter;
  const legacy = deps.legacy;
  const metrics = deps.metrics || createShadowMetrics();
  const log = deps.logger || { warn() {}, info() {}, error() {} };
  const isEnabled = typeof deps.enabled === 'function' ? deps.enabled : () => Boolean(deps.enabled);
  // event.componentId is a logical label; ignore it (kernel uses fresh physical ids).
  const IGNORE = new Set(['event.componentId']);

  if (!adapter || typeof adapter.record !== 'function') {
    throw new Error('observabilityShadow: an Observability Adapter is required');
  }
  if (!legacy || typeof legacy.observe !== 'function') {
    throw new Error('observabilityShadow: a legacy observability source is required');
  }

  /** Compare two flattened observations; record each leaf (with coverage key). */
  function compare(legacyObs, kernelObs, latencyMs) {
    const lf = flatten(legacyObs);
    const kf = flatten(kernelObs);
    const keys = new Set([...Object.keys(lf), ...Object.keys(kf)].filter((k) => !IGNORE.has(k)));
    metrics.setDeclaredSurface(keys.size);
    let matched = 0;
    let mismatched = 0;
    const mismatchKeys = [];
    for (const key of keys) {
      const eq = Object.prototype.hasOwnProperty.call(kf, key) && deepEqual(lf[key], kf[key]);
      metrics.recordComparison(eq, latencyMs, key); // key ⇒ coverage
      if (eq) matched++;
      else {
        mismatched++;
        mismatchKeys.push(key);
        metrics.recordMismatch({ key, legacyValue: lf[key], kernelValue: kf[key] });
      }
    }
    return { fields: keys.size, matched, mismatched, mismatchKeys };
  }

  /** Run ONE parity pass (async): record legacy obs → read back → compare. Never throws. */
  async function verify() {
    metrics.recordRequest();
    const legacyObs = legacy.observe();
    if (!isEnabled() || !adapter.consumed()) {
      return { enabled: false, fields: 0, matched: 0, mismatched: 0, parityPct: 100 };
    }
    const t0 = Date.now();
    try {
      const componentId = await adapter.record(legacyObs);
      const kernelObs = await adapter.readComponent(componentId);
      const latencyMs = Date.now() - t0;
      if (!kernelObs) throw new Error('kernel readback returned no component');
      const res = compare(legacyObs, kernelObs, latencyMs);
      const parityPct =
        res.fields > 0 ? Math.round((res.matched / res.fields) * 100000) / 1000 : 100;
      const snap = metrics.snapshot();
      return {
        enabled: true,
        ...res,
        parityPct,
        confidenceLevel: snap.confidenceLevel,
        coveragePct: snap.coveragePct,
      };
    } catch (e) {
      metrics.recordVerificationFailure({ error: e.message });
      log.warn('observabilityShadow: verification failed; legacy result authoritative', {
        error: e.message,
      });
      return {
        enabled: true,
        error: e.message,
        fields: 0,
        matched: 0,
        mismatched: 0,
        parityPct: 0,
      };
    }
  }

  /**
   * The shadow observe. ALWAYS returns the legacy observation immediately. When enabled, a
   * parity pass is scheduled fire-and-forget (never blocks, never throws to the caller).
   */
  function shadowObserve() {
    const legacyObs = legacy.observe();
    if (isEnabled() && adapter.consumed()) {
      Promise.resolve()
        .then(() => verify())
        .catch(() => {});
    }
    return legacyObs; // ← authoritative, unconditional
  }

  return Object.freeze({
    name: 'observability-shadow',
    enabled: () => isEnabled() && adapter.consumed(),
    deepEqual,
    flatten,
    verify,
    shadowObserve,
    stats: () => metrics.snapshot(),
    metrics,
  });
}

module.exports = { createObservabilityShadow, deepEqual, flatten };
