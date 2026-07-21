'use strict';

/**
 * Release Strategies (Phase 16.4 / ADR-045 §3) — deterministic, interchangeable rollout
 * strategies selected through dependency injection: immediate, rolling, blue-green, canary.
 *
 * A strategy never touches the host or kernels directly; it drives an injected `ops`
 * facade (deploy / health / undeploy) the Deployment Runtime binds to the Host Runtime
 * (ADR-044). Every strategy is deterministic: given the same service + params it produces
 * the same ordered step list, using the injected clock for timing only.
 *
 *   execute({ service, descriptor, ops, logger, clock, params }) →
 *     { ok, strategy, steps: [{ step, at, ok, detail }], version }
 */

const { ReleaseStrategyError, DeploymentExecutionError } = require('./errors');

const STRATEGY_NAMES = Object.freeze(['immediate', 'rolling', 'blue-green', 'canary']);

function record(steps, name, at, ok, detail) {
  steps.push({ step: name, at, ok, detail: detail || null });
  return ok;
}

async function assertHealthy(ops, id, steps, label, clock) {
  const h = await ops.health(id);
  const ok = Boolean(h && h.ok);
  record(steps, label, clock(), ok, h);
  if (!ok) {
    throw new DeploymentExecutionError(`release: health check failed at "${label}"`, { health: h });
  }
  return ok;
}

/** Immediate — deploy once, verify once. */
async function immediate(exec) {
  const { service, descriptor, ops, clock } = exec;
  const steps = [];
  await ops.deploy(service);
  record(steps, 'deploy', clock(), true, { service: descriptor.id });
  await assertHealthy(ops, descriptor.id, steps, 'verify', clock);
  return { ok: true, strategy: 'immediate', steps, version: descriptor.version };
}

/** Rolling — deploy, then verify across N deterministic waves. */
async function rolling(exec) {
  const { service, descriptor, ops, clock, params } = exec;
  const waves = Math.max(1, Number(params.waves) || 3);
  const steps = [];
  await ops.deploy(service);
  record(steps, 'deploy', clock(), true, { service: descriptor.id, waves });
  for (let i = 1; i <= waves; i += 1) {
    await assertHealthy(ops, descriptor.id, steps, `wave-${i}`, clock);
  }
  return { ok: true, strategy: 'rolling', steps, version: descriptor.version };
}

/** Blue-Green — bring up green, verify green, switch; blue is retained for rollback. */
async function blueGreen(exec) {
  const { service, descriptor, ops, clock } = exec;
  const steps = [];
  record(steps, 'blue-active', clock(), true, { previous: exec.previousVersion || null });
  await ops.deploy(service);
  record(steps, 'green-deploy', clock(), true, { service: descriptor.id });
  await assertHealthy(ops, descriptor.id, steps, 'green-verify', clock);
  record(steps, 'switch-traffic', clock(), true, { to: descriptor.version });
  return { ok: true, strategy: 'blue-green', steps, version: descriptor.version };
}

/** Canary — deploy, then verify at each deterministic canary percentage. */
async function canary(exec) {
  const { service, descriptor, ops, clock, params } = exec;
  const stages =
    Array.isArray(params.stages) && params.stages.length ? params.stages : [10, 50, 100];
  const steps = [];
  await ops.deploy(service);
  record(steps, 'deploy', clock(), true, { service: descriptor.id, stages });
  for (const pct of stages) {
    await assertHealthy(ops, descriptor.id, steps, `canary-${pct}`, clock);
  }
  return { ok: true, strategy: 'canary', steps, version: descriptor.version };
}

const STRATEGIES = Object.freeze({
  immediate,
  rolling,
  'blue-green': blueGreen,
  canary,
});

/**
 * Resolve a release strategy by name, or accept a custom strategy object/function (DI).
 * @param {string|Function|object} strategy
 */
function createReleaseStrategy(strategy) {
  if (typeof strategy === 'function') {
    return { name: strategy.name || 'custom', execute: strategy };
  }
  if (strategy && typeof strategy === 'object' && typeof strategy.execute === 'function') {
    return { name: strategy.name || 'custom', execute: strategy.execute };
  }
  const name = strategy || 'immediate';
  const fn = STRATEGIES[name];
  if (!fn) {
    throw new ReleaseStrategyError(`release: unknown strategy "${name}"`, {
      known: STRATEGY_NAMES,
    });
  }
  return { name, execute: fn };
}

module.exports = { createReleaseStrategy, STRATEGIES, STRATEGY_NAMES };
