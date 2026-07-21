'use strict';

/**
 * Deployment Verifier (Phase 16.4 / ADR-045 §8) — before a deployment is declared
 * successful, confirms: deployment plan completed, host healthy, runtime healthy, all
 * services healthy, compatibility passed, and the release strategy completed. It delegates
 * every underlying check to the Host Runtime (ADR-044), the Bootstrap Runtime (ADR-043),
 * and the Compatibility Kernel (ADR-041) — it re-implements none of them.
 */

const { DeploymentVerificationError } = require('./errors');

function createDeploymentVerifier(deps = {}) {
  const host = deps.host;
  const log = deps.logger || { info() {}, warn() {}, error() {} };

  /**
   * @param {object} ctx { plan, strategyResult }
   */
  async function verify(ctx = {}) {
    const checks = {};

    // deployment plan completed
    checks.planCompleted = { ok: Boolean(ctx.plan && ctx.plan.ok) };

    // host healthy (aggregates services + readiness)
    const hostHealth = await host.health();
    checks.hostHealthy = { ok: hostHealth.status === 'healthy' };

    // runtime healthy (delegated to ADR-043)
    let runtimeHealthy = false;
    try {
      const rh = await host.runtime().health();
      runtimeHealthy = rh.status === 'healthy';
    } catch (e) {
      log.warn('verifier: runtime health errored', { error: e.message });
    }
    checks.runtimeHealthy = { ok: runtimeHealthy };

    // all services healthy
    const services = hostHealth.services || {};
    const unhealthy = Object.entries(services)
      .filter(([, h]) => h && h.ok === false)
      .map(([id]) => id);
    checks.allServicesHealthy = { ok: unhealthy.length === 0, unhealthy };

    // compatibility passed (Compatibility Kernel, ADR-041, via the platform)
    checks.compatibilityPassed = await compatibilityOk(ctx.plan);

    // deployment strategy completed
    checks.strategyCompleted = {
      ok: Boolean(ctx.strategyResult && ctx.strategyResult.ok),
      strategy: ctx.strategyResult && ctx.strategyResult.strategy,
    };

    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, checks };
  }

  async function compatibilityOk(plan) {
    // If the plan already computed version compatibility, reuse it.
    if (plan && plan.checks && plan.checks.versionCompatibility) {
      return { ok: Boolean(plan.checks.versionCompatibility.ok) };
    }
    try {
      const platform = host.runtime().platform();
      const compat = platform && platform.getKernel && platform.getKernel('compatibility');
      if (!compat) return { ok: true, note: 'no compatibility kernel' };
      const v = await compat.verify({});
      return { ok: Boolean(v && v.ok) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function assertVerified(result) {
    if (!result.ok) {
      throw new DeploymentVerificationError('deployment verification failed', result.checks);
    }
    return result;
  }

  return { verify, assertVerified };
}

module.exports = { createDeploymentVerifier };
