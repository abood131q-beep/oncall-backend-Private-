'use strict';

/**
 * metrics.js — Configuration shadow metrics (17.3; unified in 18.0).
 *
 * `createConfigShadowMetrics` is now a thin alias over the shared `createShadowMetrics`
 * (`src/platform-adapters/_shadow/`), so the Configuration shadow emits the FULL G1.0 §5 metric
 * set — including `confidenceLevel` and `coveragePct` — with a single, canonical implementation
 * (no duplicated metrics). The name is preserved for backward compatibility with existing
 * imports and tests. Recording a metric still has NO effect on runtime behavior and is isolated
 * from the app's `/metrics`.
 */

const { createShadowMetrics } = require('../_shadow');

function createConfigShadowMetrics(opts = {}) {
  return createShadowMetrics(opts);
}

module.exports = { createConfigShadowMetrics };
