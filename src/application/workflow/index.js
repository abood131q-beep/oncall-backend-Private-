'use strict';

/**
 * Workflow Platform — composition entry point (Phase 14.4 / ADR-023). Wires the
 * engine with the other kernel services (Storage/Lock/Scheduler/Config) and the
 * Event Backbone, returning the integrated Kernel Platform surface. Purely
 * additive: nothing here is imported by a hot path, so the platform runs
 * byte-identically whether or not the workflow engine is instantiated.
 *
 *   const wf = createWorkflowPlatform({ storage, lock, scheduler, config, publisher });
 *   wf.engine.register(definition);
 *   const inst = await wf.engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
 *   await wf.engine.signal({ workflowId: inst.workflowId, event: 'accept', payload: { driver: 'd1' } });
 */

const { createWorkflowEngine } = require('./workflowService');
const { createWorkflowMetrics } = require('./metrics');
const { WORKFLOW_EVENTS } = require('../../domain/workflow/events');

function createWorkflowPlatform(deps = {}) {
  const metrics = deps.metrics || createWorkflowMetrics({ clock: deps.clock });
  const engine = createWorkflowEngine({
    storage: deps.storage,
    lock: deps.lock,
    scheduler: deps.scheduler,
    config: deps.config,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    engineId: deps.engineId,
    idFactory: deps.idFactory,
  });
  return { engine, metrics, WORKFLOW_EVENTS };
}

module.exports = {
  createWorkflowPlatform,
  createWorkflowEngine,
  createWorkflowMetrics,
  WORKFLOW_EVENTS,
};
