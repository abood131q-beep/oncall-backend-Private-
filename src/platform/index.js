'use strict';

/**
 * Enterprise Platform Composition Root — public entry point (Phase 16.1 / ADR-042).
 *
 * This is NOT a Kernel and NOT an application service. It is the ONE place that composes
 * every Enterprise Kernel (ADR-016 … ADR-041) into a single production-ready runtime,
 * while preserving complete kernel independence: no kernel imports, instantiates, or
 * knows another kernel; the builder injects dependencies through each kernel's own
 * composition root and public ports only.
 *
 * Everything is strictly additive: importing this module wires nothing on its own — a
 * runtime exists only once `createPlatform(...)` is called — so the platform runs
 * byte-identically whether or not the composition root is instantiated.
 *
 *   const { createPlatform } = require('./src/platform');
 *   const platform = createPlatform({ environment: 'production' });
 *   await platform.start();            // dependency-ordered startup (delegated to Lifecycle)
 *   platform.getKernel('gateway');     // a composed kernel's public service
 *   await platform.health();           // aggregated per-kernel health + readiness
 *   await platform.verify();           // graph + ports + providers + compatibility
 *   await platform.shutdown();         // reverse-order graceful shutdown (delegated)
 */

const { createPlatform, KERNELS } = require('./platformBuilder');
const { createPlatformContext, createMutex, createPlatformMetrics } = require('./platformContext');
const { createKernelRegistry } = require('./kernelRegistry');
const { buildDependencyGraph } = require('./dependencyGraph');
const { aggregateHealth } = require('./platformHealth');
const errors = require('./errors');

module.exports = {
  createPlatform,
  KERNELS,
  // building blocks (exported for testing + advanced composition; not required for use)
  createPlatformContext,
  createMutex,
  createPlatformMetrics,
  createKernelRegistry,
  buildDependencyGraph,
  aggregateHealth,
  errors,
};
