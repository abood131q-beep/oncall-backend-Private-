'use strict';

/**
 * Enterprise Deployment Runtime — error model (Phase 16.4 / ADR-045).
 *
 * Typed errors so operators + callers branch on `err.name`/`instanceof`. The Deployment
 * Runtime is a thin orchestration layer ABOVE the Host Runtime (ADR-044); these errors
 * describe DEPLOYMENT faults only (planning, release strategy, rollback, verification).
 * Host faults surface as ADR-044's HostError family; runtime faults as ADR-043's; kernel
 * faults as the kernels' own typed errors.
 */

class DeploymentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DeploymentError';
    if (details) this.details = details;
  }
}

/** Invalid deployment options / usage in a state that does not permit the operation. */
class DeploymentStateError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeploymentStateError';
  }
}

/** A deployment request does not satisfy the deployment contract / spec. */
class DeploymentContractError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeploymentContractError';
  }
}

/** The deployment plan could not be generated or is invalid. */
class DeploymentPlanError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeploymentPlanError';
  }
}

/** An unknown or unusable release strategy was requested. */
class ReleaseStrategyError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ReleaseStrategyError';
  }
}

/** A deployment failed while executing its release strategy. */
class DeploymentExecutionError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeploymentExecutionError';
  }
}

/** A rollback could not complete or failed verification. */
class RollbackError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RollbackError';
  }
}

/** Deployment verification failed. */
class DeploymentVerificationError extends DeploymentError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeploymentVerificationError';
  }
}

module.exports = {
  DeploymentError,
  DeploymentStateError,
  DeploymentContractError,
  DeploymentPlanError,
  ReleaseStrategyError,
  DeploymentExecutionError,
  RollbackError,
  DeploymentVerificationError,
};
