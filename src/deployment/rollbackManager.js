'use strict';

/**
 * Rollback Manager (Phase 16.4 / ADR-045 §5) — reverts deployments. It supports automatic,
 * manual, partial, and full rollback plus rollback verification. It reuses the Lifecycle
 * Kernel (ADR-040) transitively: rollback restores services through the Host Runtime
 * (ADR-044), whose start/stop delegate to the Bootstrap Runtime (ADR-043) and ultimately
 * to the Lifecycle Kernel — so this manager never re-implements lifecycle ordering.
 *
 * A rollback restores the previous deployment record for a service (its retained prior
 * service instance), or undeploys the current one when there is no prior version.
 */

const { RollbackError } = require('./errors');

function createRollbackManager(deps = {}) {
  const ops = deps.ops; // { deploy, undeploy, health, hostHealth }
  const registry = deps.registry;
  const supervisor = deps.supervisor;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { info() {}, warn() {}, error() {} };

  /** Roll one service back to its previous record (or undeploy if none). */
  async function rollbackOne(record) {
    const prior = record && record.previous;
    try {
      if (prior && prior.service) {
        await ops.undeploy(record.service);
        await ops.deploy(prior.serviceInstance || prior.service);
        registry.update(record.id, {
          status: 'rolled-back',
          rolledBackAt: clock(),
          rolledBackTo: prior.version,
        });
        return { service: record.service, ok: true, restoredVersion: prior.version };
      }
      await ops.undeploy(record.service);
      registry.update(record.id, {
        status: 'rolled-back',
        rolledBackAt: clock(),
        rolledBackTo: null,
      });
      return { service: record.service, ok: true, restoredVersion: null };
    } catch (e) {
      supervisor.recordFailure('rollback', e, record.service);
      throw new RollbackError(`rollback: service "${record.service}" failed: ${e.message}`, {
        service: record.service,
      });
    }
  }

  /**
   * @param {object} opts
   * @param {string}   [opts.mode]        'full' | 'partial' | 'manual' | 'auto' (default 'full')
   * @param {string[]} [opts.services]    for partial/manual: subset of service ids
   * @param {string}   [opts.deploymentId] roll back a specific deployment record
   * @param {boolean}  [opts.verify]      verify after rollback (default true)
   */
  async function rollback(opts = {}) {
    const mode = opts.mode || 'full';
    supervisor.transition(supervisor.STATES.ROLLING_BACK);

    let records;
    if (opts.deploymentId) {
      records = [registry.resolve(opts.deploymentId)];
    } else if ((mode === 'partial' || mode === 'manual') && Array.isArray(opts.services)) {
      records = opts.services.map((sid) => registry.current(sid)).filter(Boolean);
    } else {
      // full/auto: current record of every deployed service, reverse of deploy order
      records = registry
        .services()
        .map((sid) => registry.current(sid))
        .filter(Boolean)
        .reverse();
    }

    const results = [];
    for (const rec of records) {
      results.push(await rollbackOne(rec));
    }

    let verification = null;
    if (opts.verify !== false) {
      verification = await verifyRollback(records.map((r) => r.service));
      if (!verification.ok && mode !== 'auto') {
        supervisor.transition(supervisor.STATES.FAILED);
        throw new RollbackError('rollback verification failed', { verification });
      }
    }
    supervisor.transition(supervisor.STATES.ROLLED_BACK);
    log.info('rollback complete', { mode, services: results.map((r) => r.service) });
    return { ok: results.every((r) => r.ok), mode, results, verification };
  }

  /** Rollback verification: host healthy + each rolled-back service is settled. */
  async function verifyRollback(serviceIds = []) {
    const hostHealth = await ops.hostHealth();
    const services = {};
    for (const id of serviceIds) {
      const s = hostHealth.services && hostHealth.services[id];
      // A rolled-back/undeployed service should be gone or healthy — never failing.
      services[id] = !s || s.ok !== false;
    }
    const ok = hostHealth.status !== 'unhealthy' && Object.values(services).every(Boolean);
    return { ok, hostStatus: hostHealth.status, services };
  }

  return { rollback, rollbackOne, verifyRollback };
}

module.exports = { createRollbackManager };
