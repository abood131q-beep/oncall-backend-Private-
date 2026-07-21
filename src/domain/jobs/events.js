'use strict';

/**
 * Background Jobs event catalog (Phase 15.3 / ADR-032 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'jobs'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const JOB_EVENTS = Object.freeze({
  REGISTERED: 'JobRegistered',
  QUEUED: 'JobQueued',
  STARTED: 'JobStarted',
  COMPLETED: 'JobCompleted',
  FAILED: 'JobFailed',
  RETRIED: 'JobRetried',
  CANCELLED: 'JobCancelled',
});

const KNOWN = new Set(Object.values(JOB_EVENTS));
const isJobEvent = (type) => KNOWN.has(type);

function createJobEvent(type, payload = {}, opts = {}) {
  if (!isJobEvent(type)) throw new Error(`jobs events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'jobs',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.jobId || payload.type)) || null,
      correlationId: opts.correlationId || (payload && payload.correlationId) || undefined,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { JOB_EVENTS, isJobEvent, createJobEvent };
