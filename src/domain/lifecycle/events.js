'use strict';

/**
 * Lifecycle Management event catalog (Phase 15.11 / ADR-040 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'lifecycle'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const LIFECYCLE_EVENTS = Object.freeze({
  COMPONENT_REGISTERED: 'ComponentRegistered',
  COMPONENT_INITIALIZED: 'ComponentInitialized',
  COMPONENT_STARTED: 'ComponentStarted',
  COMPONENT_STOPPED: 'ComponentStopped',
  COMPONENT_RESTARTED: 'ComponentRestarted',
  STATE_CHANGED: 'LifecycleStateChanged',
  VERIFIED: 'LifecycleVerified',
});

const KNOWN = new Set(Object.values(LIFECYCLE_EVENTS));
const isLifecycleEvent = (type) => KNOWN.has(type);

function createLifecycleEvent(type, payload = {}, opts = {}) {
  if (!isLifecycleEvent(type)) throw new Error(`lifecycle events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'lifecycle',
      version: opts.version || 1,
      subject: opts.subject || (payload && payload.componentId) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { LIFECYCLE_EVENTS, isLifecycleEvent, createLifecycleEvent };
