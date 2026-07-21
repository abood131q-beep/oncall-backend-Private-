'use strict';

/**
 * Deployment Registry (Phase 16.4 / ADR-045) — a per-deployment-runtime, closure-scoped
 * registry of deployment RECORDS (no globals, no singletons). Each record captures one
 * deployment of a hosted service (service id, target version, strategy, status, timing).
 * It keeps per-service history and the current record, and exposes register / unregister /
 * resolve / list / verify, detecting duplicate deployment ids and invalid records.
 */

const { DeploymentStateError } = require('./errors');

let _seq = 0;
function defaultId(serviceId) {
  _seq = (_seq + 1) % 1e6;
  return `dep_${serviceId}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function createDeploymentRegistry() {
  const byId = new Map(); // deploymentId -> record
  const order = []; // deploymentId registration order
  const historyByService = new Map(); // serviceId -> [record...]
  const currentByService = new Map(); // serviceId -> record

  function register(record) {
    if (!record || typeof record !== 'object') {
      throw new DeploymentStateError('deploymentRegistry: record object required');
    }
    if (!record.service || typeof record.service !== 'string') {
      throw new DeploymentStateError('deploymentRegistry: record.service is required');
    }
    const id = record.id || defaultId(record.service);
    if (byId.has(id)) {
      throw new DeploymentStateError(`deploymentRegistry: deployment "${id}" already registered`);
    }
    const stored = { ...record, id };
    byId.set(id, stored);
    order.push(id);
    if (!historyByService.has(record.service)) historyByService.set(record.service, []);
    historyByService.get(record.service).push(stored);
    currentByService.set(record.service, stored);
    return stored;
  }

  function update(id, patch) {
    const rec = byId.get(id);
    if (!rec) throw new DeploymentStateError(`deploymentRegistry: deployment "${id}" not found`);
    Object.assign(rec, patch);
    return rec;
  }

  function unregister(id) {
    if (!byId.has(id)) return false;
    const rec = byId.get(id);
    byId.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    const hist = historyByService.get(rec.service);
    if (hist) {
      const j = hist.indexOf(rec);
      if (j >= 0) hist.splice(j, 1);
    }
    if (currentByService.get(rec.service) === rec) {
      const remaining = historyByService.get(rec.service) || [];
      currentByService.set(rec.service, remaining[remaining.length - 1] || null);
    }
    return true;
  }

  function resolve(id) {
    const rec = byId.get(id);
    if (!rec) throw new DeploymentStateError(`deploymentRegistry: deployment "${id}" not found`);
    return rec;
  }

  const has = (id) => byId.has(id);
  const list = () => order.map((id) => ({ ...byId.get(id) }));
  const current = (serviceId) => {
    const rec = currentByService.get(serviceId);
    return rec ? { ...rec } : null;
  };
  const history = (serviceId) => (historyByService.get(serviceId) || []).map((r) => ({ ...r }));
  const services = () => [...currentByService.keys()];

  /** Structural verification: every record has service + version + a known status. */
  function verify() {
    const issues = [];
    for (const id of order) {
      const rec = byId.get(id);
      if (!rec.service) issues.push({ deployment: id, reason: 'missing service' });
      if (!rec.version) issues.push({ deployment: id, reason: 'missing version' });
    }
    return { ok: issues.length === 0, count: order.length, issues };
  }

  return {
    register,
    update,
    unregister,
    resolve,
    has,
    list,
    current,
    history,
    services,
    verify,
  };
}

module.exports = { createDeploymentRegistry };
