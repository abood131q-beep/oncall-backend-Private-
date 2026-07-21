'use strict';

/**
 * _shadow/index.js — Shared Shadow Framework (G1.0 §7 reference) public surface.
 *
 * Aggregates the reusable primitives every shadow integration needs, so kernels do not
 * re-implement them:
 *   • core.js            — deepEqual / flatten / typeOf / redactValue / createShadowMetrics
 *                          (full G1.0 §5 metric set incl. confidenceLevel + coveragePct)
 *   • roundTripShadow.js — createRoundTripShadow: the generic "for each legacy item: record →
 *                          readBack → compare" verifier used by Jobs (17.5) and Scheduler
 *                          (17.6) and future kernels — so per-kernel shadows are thin config.
 *
 * All exports are pure and side-effect-free. This is the go-forward canonical implementation;
 * the pre-G1.0 Configuration (17.3) and Observability (17.4) shadows keep their own local
 * copies and MAY adopt this module when next touched.
 */

const core = require('./core');
const { createRoundTripShadow, compareViews } = require('./roundTripShadow');
const { createReadThroughShadow } = require('./readThroughShadow');

module.exports = {
  ...core,
  createRoundTripShadow,
  compareViews,
  createReadThroughShadow,
};
