'use strict';

/**
 * Deployment (Phase 16.4 / ADR-045 §1, §2, §9) — the object returned by createDeployment.
 * It orchestrates deployments of hosted services on top of the Host Runtime (ADR-044)
 * WITHOUT modifying the Host, Runtime, or any kernel: it drives everything through the
 * host's public API. It exposes the §2 deployment contract plus health().
 *
 *   deploy() rollback() verify() status() history() version() metadata()   (+ health())
 *
 * Release strategies are injected (§3); the planner generates + validates plans (§4) and
 * never executes them; the rollback manager (§5) restores prior versions through the host
 * (reusing ADR-040 lifecycle transitively); the verifier (§8) confirms success.
 */

const { createReleaseStrategy } = require('./releaseStrategy');
const { createDeploymentPlanner } = require('./deploymentPlanner');
const { createRollbackManager } = require('./rollbackManager');
const { createDeploymentVerifier } = require('./deploymentVerifier');
const {
  DeploymentPlanError,
  DeploymentContractError,
  DeploymentExecutionError,
  DeploymentVerificationError,
} = require('./errors');

function lightDescriptor(service) {
  return {
    id: service.id(),
    name: service.name(),
    version: service.version(),
    dependsOn: service.dependencies(),
  };
}

function createDeploymentObject(deps = {}) {
  const context = deps.context;
  const registry = deps.registry;
  const supervisor = deps.supervisor;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };
  const host = context.host;

  // ── ops facade — the ONLY seam to the Host Runtime (register/start/stop/health) ─────
  const ops = {
    async deploy(service) {
      const id = service.id();
      if (host.getService(id)) await host.unregister(id); // replace on redeploy
      const descriptor = await host.register(service); // starts now if host is ready…
      if (!host.supervisor.isReady()) await host.start(); // …otherwise bring the host up
      return descriptor;
    },
    async undeploy(id) {
      return host.unregister(id);
    },
    async health(id) {
      const h = await host.health();
      return (h.services && h.services[id]) || null;
    },
    async hostHealth() {
      return host.health();
    },
  };

  const planner = createDeploymentPlanner({ host, clock, logger: log });
  const verifier = createDeploymentVerifier({ host, logger: log });
  const rollbackManager = createRollbackManager({ ops, registry, supervisor, clock, logger: log });

  const last = { plan: null, strategyResult: null, deploymentId: null };

  // ── §2 deploy ─────────────────────────────────────────────────────────────────────
  async function deploy(request = {}) {
    const service = request.service;
    if (!service || typeof service.id !== 'function') {
      throw new DeploymentContractError('deploy: a hosted service (ADR-044 contract) is required');
    }
    const descriptor = lightDescriptor(service);
    const strategyName = request.strategy || 'immediate';

    // §4 plan (generate + validate; never execute)
    supervisor.transition(supervisor.STATES.PLANNING);
    const plan = await planner.plan({
      service,
      version: request.version,
      strategy: strategyName,
      contractId: request.contractId,
      resourceRequest: request.resourceRequest,
    });
    last.plan = plan;
    if (!plan.ok) {
      supervisor.recordFailure('plan', new Error('invalid plan'), descriptor.id);
      supervisor.transition(supervisor.STATES.FAILED);
      throw new DeploymentPlanError('deploy: plan validation failed', plan.checks);
    }

    // record (retain the prior deployment for rollback)
    const previous = registry.current(descriptor.id);
    const record = registry.register({
      service: descriptor.id,
      version: plan.version,
      strategy: strategyName,
      status: 'deploying',
      serviceInstance: service,
      previous,
      startedAt: clock(),
    });
    last.deploymentId = record.id;

    // §3 execute the injected release strategy
    supervisor.transition(supervisor.STATES.DEPLOYING);
    const strategy = createReleaseStrategy(request.strategy);
    supervisor.setStrategy(strategy.name);
    const start = clock();
    let strategyResult;
    try {
      strategyResult = await strategy.execute({
        service,
        descriptor,
        ops,
        logger: log,
        clock,
        params: request.params || {},
        previousVersion: previous ? previous.version : null,
      });
    } catch (e) {
      registry.update(record.id, { status: 'failed', failedAt: clock() });
      supervisor.recordFailure('deploy', e, descriptor.id);
      supervisor.setDuration(clock() - start);
      supervisor.transition(supervisor.STATES.FAILED);
      if (request.autoRollback !== false) {
        await rollbackManager
          .rollback({ mode: 'auto', deploymentId: record.id, verify: false })
          .catch((re) => {
            supervisor.recordFailure('rollback', re, descriptor.id);
          });
      }
      throw e instanceof DeploymentExecutionError
        ? e
        : new DeploymentExecutionError(`deploy: strategy "${strategy.name}" failed: ${e.message}`);
    }
    last.strategyResult = strategyResult;

    // §8 verify before declaring success
    supervisor.transition(supervisor.STATES.VERIFYING);
    const verification = await verifier.verify({ plan, strategyResult });
    supervisor.setVerification(verification.ok);
    supervisor.setDuration(clock() - start);
    if (!verification.ok) {
      registry.update(record.id, { status: 'failed', failedAt: clock() });
      supervisor.recordFailure('verify', new Error('verification failed'), descriptor.id);
      supervisor.transition(supervisor.STATES.FAILED);
      if (request.autoRollback !== false) {
        await rollbackManager
          .rollback({ mode: 'auto', deploymentId: record.id, verify: false })
          .catch((re) => {
            supervisor.recordFailure('rollback', re, descriptor.id);
          });
      }
      throw new DeploymentVerificationError('deploy: verification failed', verification.checks);
    }

    registry.update(record.id, { status: 'deployed', deployedAt: clock() });
    supervisor.transition(supervisor.STATES.DEPLOYED);
    return {
      ok: true,
      deploymentId: record.id,
      service: descriptor.id,
      version: plan.version,
      strategy: strategy.name,
      plan,
      strategyResult,
      verification,
      durationMs: supervisor.snapshot().deploymentDurationMs,
    };
  }

  // ── §2 rollback ─────────────────────────────────────────────────────────────────────
  async function rollback(opts = {}) {
    return rollbackManager.rollback(opts);
  }

  // ── §2 verify (re-verify the current deployment) ─────────────────────────────────────
  async function verify() {
    const result = await verifier.verify({ plan: last.plan, strategyResult: last.strategyResult });
    supervisor.setVerification(result.ok);
    return result;
  }

  // ── §2 status / history / version / metadata ──────────────────────────────────────
  function status() {
    return {
      supervisor: supervisor.snapshot(),
      lastDeploymentId: last.deploymentId,
      deployments: registry.list(),
    };
  }
  function history(serviceId) {
    return serviceId ? registry.history(serviceId) : registry.list();
  }
  function version() {
    const cur = last.deploymentId ? registry.resolve(last.deploymentId).version : null;
    return cur || context.version;
  }
  function metadata() {
    return {
      environment: context.environment,
      version: context.version,
      strategies: ['immediate', 'rolling', 'blue-green', 'canary'],
      deploymentMetadata: context.deploymentMetadata,
    };
  }

  // ── §9 health ─────────────────────────────────────────────────────────────────────
  async function health() {
    const hostHealth = await host.health();
    const sup = supervisor.snapshot();
    return {
      status: sup.failed ? 'failed' : hostHealth.status === 'healthy' ? 'healthy' : 'degraded',
      deployment: sup,
      activeDeployment: last.deploymentId
        ? { id: last.deploymentId, ...safeResolve(registry, last.deploymentId) }
        : null,
      currentReleaseStrategy: sup.strategy,
      rollbackReadiness: { ready: supervisor.rollbackReady(), services: registry.services() },
      verificationState: sup.verificationState,
      host: { status: hostHealth.status },
    };
  }

  return Object.freeze({
    deploy,
    rollback,
    verify,
    status,
    history,
    version,
    metadata,
    health,
    // read-only accessors (not part of the §2 contract surface)
    supervisor,
    context: () => context,
  });
}

function safeResolve(registry, id) {
  try {
    const r = registry.resolve(id);
    return { service: r.service, version: r.version, status: r.status, strategy: r.strategy };
  } catch {
    return {};
  }
}

module.exports = { createDeploymentObject };
