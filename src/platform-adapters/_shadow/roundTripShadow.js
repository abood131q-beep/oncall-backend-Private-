'use strict';

/**
 * roundTripShadow.js — Shared generic shadow verifier (G1.0 §7 generalization).
 *
 * Every "round-trip" shadow so far (Jobs 17.5, Scheduler 17.6, and future kernels) follows the
 * SAME algorithm: for each legacy item, place a representation into the kernel through the
 * adapter, read it back, and deep-compare a per-item "view" field-by-field — never throwing,
 * never blocking, always non-authoritative. This module captures that algorithm ONCE so
 * per-kernel shadows become thin configuration rather than duplicated control flow.
 *
 * A kernel supplies:
 *   • legacy       — { list(): item[] }               (the Source of Truth inventory)
 *   • adapter      — { consumed(), record(item)->ref, readRef(ref)->view } (only kernel seam)
 *   • buildLegacyView(item) -> comparable object      (what the kernel must reproduce)
 *   • itemKey(item) -> string                         (id used for mismatch labels)
 *   • countLabel   — e.g. 'jobs' | 'schedules'        (report count field name)
 *
 * Guarantees (G1.0 §1): verify() never throws to the caller, never blocks (single awaited
 * out-of-band pass), never mutates app/persistent state; on any kernel/adapter error it records
 * a verification failure and returns. When disabled it performs NO kernel interaction.
 */

const { deepEqual, flatten, redactValue, createShadowMetrics } = require('./core');

/** Compare two per-item views leaf-by-leaf; record each comparison (with coverage key). */
function compareViews(metrics, itemId, legacyView, kernelView, latencyMs) {
  const lf = flatten(legacyView);
  const kf = flatten(kernelView);
  const keys = new Set([...Object.keys(lf), ...Object.keys(kf)]);
  let matched = 0;
  let mismatched = 0;
  const mismatchKeys = [];
  for (const leaf of keys) {
    const eq = Object.prototype.hasOwnProperty.call(kf, leaf) && deepEqual(lf[leaf], kf[leaf]);
    metrics.recordComparison(eq, latencyMs, leaf); // leaf = coverage category
    if (eq) matched++;
    else {
      mismatched++;
      mismatchKeys.push(leaf);
      metrics.recordMismatch({
        item: itemId,
        key: leaf,
        legacyValue: redactValue(leaf, lf[leaf]),
        kernelValue: redactValue(leaf, kf[leaf]),
      });
    }
  }
  return { matched, mismatched, mismatchKeys };
}

/**
 * @param {object} deps see module docstring.
 * @returns {{ name, enabled, verify, stats, metrics }}
 */
function createRoundTripShadow(deps = {}) {
  const {
    name = 'round-trip-shadow',
    adapter,
    legacy,
    buildLegacyView,
    itemKey = (i) => String(i && i.id),
    countLabel = 'items',
    logger,
  } = deps;
  const metrics = deps.metrics || createShadowMetrics();
  const log = logger || { warn() {}, info() {}, error() {} };
  const isEnabled = typeof deps.enabled === 'function' ? deps.enabled : () => Boolean(deps.enabled);

  if (!adapter || typeof adapter.record !== 'function' || typeof adapter.readRef !== 'function') {
    throw new Error(`${name}: an adapter exposing record()+readRef() is required`);
  }
  if (!legacy || typeof legacy.list !== 'function') {
    throw new Error(`${name}: a legacy source exposing list() is required`);
  }
  if (typeof buildLegacyView !== 'function') {
    throw new Error(`${name}: buildLegacyView(item) is required`);
  }

  async function verify() {
    metrics.recordRequest();
    const items = legacy.list();
    if (!isEnabled() || !adapter.consumed()) {
      return {
        enabled: false,
        [countLabel]: items.length,
        fields: 0,
        matched: 0,
        mismatched: 0,
        parityPct: 100,
      };
    }
    // Declared surface = distinct leaf keys of one item's comparable view (for coveragePct).
    metrics.setDeclaredSurface(Object.keys(flatten(buildLegacyView(items[0] || {}))).length);

    let fields = 0;
    let matched = 0;
    let mismatched = 0;
    const mismatchKeys = [];
    const t0 = Date.now();
    try {
      for (const item of items) {
        const ref = await adapter.record(item); // never executes / never ticks (adapter contract)
        const kernelView = await adapter.readRef(ref);
        if (!kernelView)
          throw new Error(`kernel read-back returned nothing for "${itemKey(item)}"`);
        const res = compareViews(
          metrics,
          itemKey(item),
          buildLegacyView(item),
          kernelView,
          Date.now() - t0
        );
        fields += res.matched + res.mismatched;
        matched += res.matched;
        mismatched += res.mismatched;
        for (const k of res.mismatchKeys) mismatchKeys.push(`${itemKey(item)}.${k}`);
      }
    } catch (e) {
      metrics.recordVerificationFailure({ error: e.message });
      log.warn(`${name}: verification failed; legacy remains authoritative`, { error: e.message });
      return {
        enabled: true,
        error: e.message,
        [countLabel]: items.length,
        fields,
        matched,
        mismatched,
        parityPct: 0,
      };
    }

    const parityPct = fields > 0 ? Math.round((matched / fields) * 100000) / 1000 : 100;
    const snap = metrics.snapshot();
    return {
      enabled: true,
      [countLabel]: items.length,
      fields,
      matched,
      mismatched,
      mismatchKeys,
      parityPct,
      confidenceLevel: snap.confidenceLevel,
      coveragePct: snap.coveragePct,
    };
  }

  return Object.freeze({
    name,
    enabled: () => isEnabled() && adapter.consumed(),
    verify,
    stats: () => metrics.snapshot(),
    metrics,
  });
}

module.exports = { createRoundTripShadow, compareViews };
