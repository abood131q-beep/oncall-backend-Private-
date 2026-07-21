'use strict';

/**
 * Service Mesh event catalog (Phase 15.8 / ADR-037 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'mesh'); the service publishes them ONLY through
 * the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const MESH_EVENTS = Object.freeze({
  CONNECTION_REGISTERED: 'ConnectionRegistered',
  CONNECTION_ESTABLISHED: 'ConnectionEstablished',
  INVOCATION_STARTED: 'InvocationStarted',
  INVOCATION_COMPLETED: 'InvocationCompleted',
  INVOCATION_FAILED: 'InvocationFailed',
  CONNECTION_CLOSED: 'ConnectionClosed',
  MESH_VERIFIED: 'MeshVerified',
});

const KNOWN = new Set(Object.values(MESH_EVENTS));
const isMeshEvent = (type) => KNOWN.has(type);

function createMeshEvent(type, payload = {}, opts = {}) {
  if (!isMeshEvent(type)) throw new Error(`mesh events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'mesh',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.connectionId || payload.invocationId)) || null,
      correlationId: opts.correlationId || (payload && payload.correlationId) || undefined,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { MESH_EVENTS, isMeshEvent, createMeshEvent };
