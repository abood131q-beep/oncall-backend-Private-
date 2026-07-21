'use strict';

/**
 * Deployment Builder (Phase 16.4 / ADR-045 §1) — exposes ONLY `createDeployment(options)`.
 * It manages deployments for hosted services WITHOUT modifying the Host Runtime (ADR-044),
 * the Bootstrap Runtime (ADR-043), or any kernel. It is a THIN orchestration layer: it
 * wires an immutable deployment context, a registry, and a supervisor, then returns the
 * Deployment object.
 *
 *   const runtime = await bootstrap(config);
 *   const host = await createHost({ runtime });
 *   const deployment = await createDeployment({ host });
 *   await deployment.deploy({ service: apiGatewayService, strategy: 'rolling' });
 *   await deployment.verify();
 */

const { createDeploymentContext } = require('./deploymentContext');
const { createDeploymentRegistry } = require('./deploymentRegistry');
const { createDeploymentSupervisor } = require('./deploymentSupervisor');
const { createDeploymentObject } = require('./deployment');
const { DeploymentStateError } = require('./errors');

/**
 * @param {object} options
 * @param {object} options.host  a Host Runtime (ADR-044) — required
 * @param {object} [options.logger]
 * @param {object} [options.metrics]
 * @param {string} [options.environment]
 * @param {string} [options.version]
 * @param {object} [options.configuration]
 * @param {object} [options.deploymentMetadata]
 * @param {Function} [options.clock]
 */
async function createDeployment(options = {}) {
  const host = options.host;
  if (!host || typeof host.register !== 'function' || typeof host.runtime !== 'function') {
    throw new DeploymentStateError('createDeployment: a Host Runtime (ADR-044) is required');
  }
  const clock = options.clock || (() => Date.now());
  const logger =
    options.logger || (typeof host.context === 'function' && host.context().logger) || undefined;

  const context = createDeploymentContext({
    host,
    logger,
    metrics: options.metrics,
    environment: options.environment,
    version: options.version,
    configuration: options.configuration,
    deploymentMetadata: options.deploymentMetadata,
  });
  const registry = createDeploymentRegistry();
  const supervisor = createDeploymentSupervisor({ clock, logger });

  return createDeploymentObject({ context, registry, supervisor, clock, logger });
}

module.exports = { createDeployment };
