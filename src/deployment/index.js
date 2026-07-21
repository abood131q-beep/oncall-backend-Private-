'use strict';

/**
 * Enterprise Deployment Runtime — public entry point (Phase 16.4 / ADR-045).
 *
 * This is NOT a Kernel, NOT a CI/CD system, and NOT Kubernetes. It is the thin
 * orchestration layer that sits directly above the Host Runtime (ADR-044): it owns
 * deployment orchestration, version rollout, rollback, deployment verification, and
 * release strategies for hosted services. It never modifies any kernel, ADR-042, ADR-043,
 * or ADR-044; it is strictly additive — importing it wires nothing until
 * `createDeployment(...)` is called.
 *
 *   import { bootstrap } from './runtime';
 *   import { createHost } from './host';
 *   import { createDeployment } from './deployment';
 *   const runtime = await bootstrap(config);
 *   const host = await createHost({ runtime });
 *   const deployment = await createDeployment({ host });
 *   await deployment.deploy({ service: apiGatewayService, strategy: 'rolling' });
 *   await deployment.verify();
 */

const { createDeployment } = require('./deploymentBuilder');
const { createDeploymentContext } = require('./deploymentContext');
const { createDeploymentRegistry } = require('./deploymentRegistry');
const { createDeploymentSupervisor, STATES } = require('./deploymentSupervisor');
const { createDeploymentPlanner } = require('./deploymentPlanner');
const { createDeploymentVerifier } = require('./deploymentVerifier');
const { createRollbackManager } = require('./rollbackManager');
const { createReleaseStrategy, STRATEGIES, STRATEGY_NAMES } = require('./releaseStrategy');
const errors = require('./errors');

module.exports = {
  createDeployment,
  // building blocks (exported for testing + advanced use; not required for normal use)
  createDeploymentContext,
  createDeploymentRegistry,
  createDeploymentSupervisor,
  createDeploymentPlanner,
  createDeploymentVerifier,
  createRollbackManager,
  createReleaseStrategy,
  STRATEGIES,
  STRATEGY_NAMES,
  STATES,
  errors,
};
