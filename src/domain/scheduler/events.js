'use strict';

/**
 * Scheduler event catalog (Phase 14.3.3 §6) — PURE domain. Self-contained so the
 * shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'scheduler'); the engine publishes them ONLY through the
 * EventPublisher port — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const SCHEDULER_EVENTS = Object.freeze({
  SCHEDULED: 'JobScheduled',
  STARTED: 'JobStarted',
  COMPLETED: 'JobCompleted',
  FAILED: 'JobFailed',
  CANCELLED: 'JobCancelled',
  TIMED_OUT: 'JobTimedOut',
  RETRIED: 'JobRetried',
  PAUSED: 'JobPaused',
  RESUMED: 'JobResumed',
});

const KNOWN = new Set(Object.values(SCHEDULER_EVENTS));
const isSchedulerEvent = (type) => KNOWN.has(type);

function createSchedulerEvent(type, payload = {}, opts = {}) {
  if (!isSchedulerEvent(type)) throw new Error(`scheduler events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'scheduler',
      version: opts.version || 1,
      subject: opts.subject || (payload && payload.jobId) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { SCHEDULER_EVENTS, isSchedulerEvent, createSchedulerEvent };
