'use strict';

/**
 * SDK ↔ Workflow adapter (Phase 14.4 / ADR-023). Gives an Extension a granted,
 * owner-scoped Workflow port WITHOUT leaking engine internals. Security:
 *   • Ownership — every workflow the extension starts is tagged with its owner id;
 *     signal/cancel/get/list are restricted to workflows it owns.
 *   • Definition scoping — registered definition names are prefixed with the
 *     owner, so extensions cannot collide or hijack another's definition.
 *   • Permission — write ops (register/start/signal/cancel) require the
 *     `workflow:write` capability; read ops (get/list) require `workflow:read`.
 *     Missing capability → PermissionError.
 */

const { PermissionError, ConfigurationError } = require('../../sdk/extensions/errors');

function toWorkflowPort(engine, { owner, canRead = true, canWrite = true } = {}) {
  if (!owner) throw new Error('toWorkflowPort: owner required');
  const prefix = `ext.${owner}.`;
  const scopedName = (name) => (name.startsWith(prefix) ? name : `${prefix}${name}`);

  const requireRead = () => {
    if (!canRead)
      throw new PermissionError(`extension "${owner}" lacks capability "workflow:read"`);
  };
  const requireWrite = () => {
    if (!canWrite)
      throw new PermissionError(`extension "${owner}" lacks capability "workflow:write"`);
  };

  async function ownGuard(workflowId) {
    const model = await engine.get(workflowId);
    if (!model || !model.metadata || model.metadata.owner !== owner) {
      throw new PermissionError(`extension "${owner}" does not own workflow "${workflowId}"`);
    }
    return model;
  }

  return {
    register(defSpec) {
      requireWrite();
      if (!defSpec || !defSpec.name)
        throw new ConfigurationError('workflow: definition name required');
      return engine.register({ ...defSpec, name: scopedName(defSpec.name) }).toModel();
    },
    start(spec = {}) {
      requireWrite();
      const definitionName = spec.definitionName ? scopedName(spec.definitionName) : undefined;
      return engine.start({
        ...spec,
        definitionName,
        metadata: { ...(spec.metadata || {}), owner },
      });
    },
    async signal(spec = {}) {
      requireWrite();
      await ownGuard(spec.workflowId);
      return engine.signal(spec);
    },
    async cancel(spec = {}) {
      requireWrite();
      const workflowId = typeof spec === 'string' ? spec : spec.workflowId;
      await ownGuard(workflowId);
      return engine.cancel(workflowId);
    },
    async get(workflowId) {
      requireRead();
      const model = await engine.get(workflowId);
      if (model && model.metadata && model.metadata.owner === owner) return model;
      return null; // not owned → invisible
    },
    list(spec = {}) {
      requireRead();
      return engine.list({ ...spec, owner });
    },
  };
}

module.exports = { toWorkflowPort };
