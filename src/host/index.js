'use strict';

/**
 * Enterprise Host Runtime — public entry point (Phase 16.3 / ADR-044).
 *
 * This is NOT a Kernel, NOT an application framework, and NOT a microservice framework. It
 * is the thin orchestration layer that sits directly above the Bootstrap Runtime
 * (ADR-043): it hosts multiple services, applications, workers, gateways, and plugins under
 * ONE Runtime while preserving complete architectural isolation. It never modifies any
 * kernel, ADR-042, or ADR-043; it is strictly additive — importing it wires nothing until
 * `createHost(...)` is called.
 *
 *   import { bootstrap } from './runtime';
 *   import { createHost } from './host';
 *   const runtime = await bootstrap(config);
 *   const host = await createHost({ runtime });
 *   await host.register(apiGatewayService);
 *   await host.register(workerService);
 *   await host.start();
 */

const { createHost } = require('./hostBuilder');
const { createHostContext } = require('./hostContext');
const { createHostRegistry, assertServiceContract, CONTRACT_METHODS } = require('./hostRegistry');
const { createHostSupervisor, STATES, SERVICE_STATES } = require('./hostSupervisor');
const { createHostLifecycle } = require('./hostLifecycle');
const errors = require('./errors');

module.exports = {
  createHost,
  // building blocks (exported for testing + advanced use; not required for normal use)
  createHostContext,
  createHostRegistry,
  assertServiceContract,
  CONTRACT_METHODS,
  createHostSupervisor,
  createHostLifecycle,
  STATES,
  SERVICE_STATES,
  errors,
};
