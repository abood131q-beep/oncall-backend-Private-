'use strict';

/**
 * Workflow event catalog (Phase 14.4 / ADR-023) — PURE domain, self-contained so
 * the shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'workflow'); the engine publishes them ONLY through the
 * EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const WORKFLOW_EVENTS = Object.freeze({
  STARTED: 'WorkflowStarted',
  TRANSITIONED: 'WorkflowTransitioned',
  COMPLETED: 'WorkflowCompleted',
  FAILED: 'WorkflowFailed',
  CANCELLED: 'WorkflowCancelled',
  SUSPENDED: 'WorkflowSuspended',
  RESUMED: 'WorkflowResumed',
  TIMED_OUT: 'WorkflowTimedOut',
});

const KNOWN = new Set(Object.values(WORKFLOW_EVENTS));
const isWorkflowEvent = (type) => KNOWN.has(type);

function createWorkflowEvent(type, payload = {}, opts = {}) {
  if (!isWorkflowEvent(type)) throw new Error(`workflow events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'workflow',
      version: opts.version || 1,
      subject: opts.subject || (payload && payload.workflowId) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { WORKFLOW_EVENTS, isWorkflowEvent, createWorkflowEvent };
