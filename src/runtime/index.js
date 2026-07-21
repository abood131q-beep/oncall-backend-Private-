'use strict';

/**
 * Enterprise Bootstrap Runtime — public entry point (Phase 16.2 / ADR-043).
 *
 * This is NOT a Kernel, NOT a framework, and NOT an application layer. It is the thin
 * production bootstrap runtime that sits directly above the Composition Root (ADR-042):
 * it creates, verifies, starts, supervises, and shuts down the complete Enterprise
 * Platform. It never modifies a kernel and never modifies ADR-042; it is strictly
 * additive — importing it wires nothing until `bootstrap(...)` is called.
 *
 *   import { bootstrap } from './runtime';
 *   const runtime = await bootstrap(config);
 *   await runtime.ready();
 */

const { bootstrap, assemble } = require('./bootstrap');
const { createRuntime } = require('./runtime');
const { createRuntimeContext } = require('./runtimeContext');
const { createRuntimeSupervisor, STATES } = require('./runtimeSupervisor');
const { createShutdownManager } = require('./shutdownManager');
const { verifyStartup } = require('./startupVerifier');
const errors = require('./errors');

module.exports = {
  bootstrap,
  // building blocks (exported for testing + advanced use; not required for normal use)
  assemble,
  createRuntime,
  createRuntimeContext,
  createRuntimeSupervisor,
  createShutdownManager,
  verifyStartup,
  STATES,
  errors,
};
