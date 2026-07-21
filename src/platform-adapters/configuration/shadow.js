'use strict';

/**
 * shadow.js — Configuration Shadow Verifier (17.3; refactored in 18.0 onto the shared
 * framework). Thin configuration over the shared **read-through** verifier
 * (`createReadThroughShadow`) + the shared metrics (`confidenceLevel` + `coveragePct`) +
 * the shared `deepEqual`. No local comparator or metrics remain.
 *
 *   Legacy Configuration → Configuration Adapter → Configuration Kernel →
 *   Parity Verification → Metrics → RETURN LEGACY VALUE
 *
 * Hard guarantees (unchanged): the kernel is NEVER authoritative — `shadowGet()` always returns
 * the LEGACY value; kernel values are never exposed (sensitive keys are redacted in records);
 * the shadow never throws to the caller and never affects runtime; disabled ⇒ no comparison.
 */

const {
  deepEqual,
  typeOf,
  isSensitiveKey,
  createShadowMetrics,
  createReadThroughShadow,
} = require('../_shadow');

function createConfigShadow(deps = {}) {
  const adapter = deps.adapter;
  const legacy = deps.legacy;
  const metrics = deps.metrics || createShadowMetrics();

  if (!adapter || typeof adapter.get !== 'function') {
    throw new Error('configShadow: a Configuration Adapter is required');
  }
  if (!legacy || typeof legacy.get !== 'function') {
    throw new Error('configShadow: a legacy config source is required');
  }

  /** Build a mismatch/verification descriptor, redacting values for sensitive keys. */
  function describe(key, legacyValue, kernelValue, extra = {}) {
    const sensitive = isSensitiveKey(key);
    const base = {
      key,
      legacyType: typeOf(legacyValue),
      kernelType: kernelValue === undefined && extra.error ? 'n/a' : typeOf(kernelValue),
      sensitive,
      ...extra,
    };
    if (!sensitive && !extra.error) {
      base.legacyValue = legacyValue;
      base.kernelValue = kernelValue;
    }
    return base;
  }

  const rt = createReadThroughShadow({
    name: 'configuration-shadow',
    adapter,
    legacy,
    metrics,
    logger: deps.logger,
    enabled: deps.enabled,
    readLegacy: (key) => legacy.get(key),
    readKernel: (key) => adapter.get(key),
    legacyHas: (key) => legacy.has(key),
    kernelHas: (key) => adapter.has(key),
    describe,
  });

  return Object.freeze({
    name: 'configuration-shadow',
    enabled: rt.enabled,
    deepEqual, // exposed for tests / back-compat
    shadowGet: rt.compareKey, // single-key read: compare + return legacy
    verifyAll: rt.verifyAll, // batch parity report (adds confidenceLevel + coveragePct)
    stats: rt.stats,
    metrics: rt.metrics,
  });
}

module.exports = { createConfigShadow, deepEqual };
