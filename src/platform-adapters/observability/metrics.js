'use strict';

/**
 * metrics.js — Observability shadow metrics (17.4; unified in 18.0).
 *
 * `createObservabilityShadowMetrics` is now a thin alias over the shared `createShadowMetrics`
 * (`src/platform-adapters/_shadow/`), so the Observability shadow emits the FULL G1.0 §5 metric
 * set — including `coveragePct` (added in 18.0) alongside `confidenceLevel` — with a single,
 * canonical implementation. The name is preserved for backward compatibility. Recording a metric
 * still has NO effect on runtime behavior and is isolated from the app's `/metrics` endpoint.
 */

const { createShadowMetrics } = require('../_shadow');

function createObservabilityShadowMetrics(opts = {}) {
  return createShadowMetrics(opts);
}

module.exports = { createObservabilityShadowMetrics };
