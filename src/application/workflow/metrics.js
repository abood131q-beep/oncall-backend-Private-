'use strict';

/**
 * Workflow metrics (Phase 14.4 / ADR-023) — observability port. Tracks workflows
 * started/completed/failed/cancelled, transitions, timeouts, active count, and
 * operation latency; exposes a Prometheus exposition. Pure in-process counters;
 * injectable clock keeps latency deterministic.
 */

function createWorkflowMetrics(opts = {}) {
  const now = opts.clock || (() => Date.now());
  let started = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let transitions = 0;
  let timeouts = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;
  // Production hardening (A-001) — additive counters.
  let schedulerReconciliations = 0;
  let lockConflicts = 0;
  let storageFailures = 0;
  let eventPublicationFailures = 0;
  let txLatTotalMs = 0;
  let txLatCount = 0;
  let durTotalMs = 0;
  let durCount = 0;

  const recordStart = () => (started += 1);
  const recordCompleted = () => (completed += 1);
  const recordFailed = () => (failed += 1);
  const recordCancelled = () => (cancelled += 1);
  const recordTransition = () => (transitions += 1);
  const recordTimeout = () => (timeouts += 1);
  const recordSchedulerReconciliation = () => (schedulerReconciliations += 1);
  const recordLockConflict = () => (lockConflicts += 1);
  const recordStorageFailure = () => (storageFailures += 1);
  const recordEventFailure = () => (eventPublicationFailures += 1);
  function recordTransitionLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      txLatTotalMs += ms;
      txLatCount += 1;
    }
  }
  function recordWorkflowDuration(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      durTotalMs += ms;
      durCount += 1;
    }
  }
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }
  async function timeOp(fn) {
    const start = now();
    try {
      return await fn();
    } finally {
      recordLatency(now() - start);
    }
  }

  function snapshot() {
    const terminated = completed + failed + cancelled;
    return {
      started,
      completed,
      failed,
      cancelled,
      transitions,
      timeouts,
      active: Math.max(0, started - terminated),
      avgLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastLatencyMs: latLastMs,
      // A-001 additions
      schedulerReconciliations,
      lockConflicts,
      storageFailures,
      eventPublicationFailures,
      avgTransitionLatencyMs: txLatCount ? txLatTotalMs / txLatCount : 0,
      avgWorkflowDurationMs: durCount ? durTotalMs / durCount : 0,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('workflow_started_total', 'Workflows started', s.started),
        g('workflow_completed_total', 'Workflows completed', s.completed),
        g('workflow_failed_total', 'Workflows failed', s.failed),
        g('workflow_cancelled_total', 'Workflows cancelled', s.cancelled),
        g('workflow_transitions_total', 'State transitions', s.transitions),
        g('workflow_timeouts_total', 'State timeouts', s.timeouts),
        g('workflow_active', 'Currently active (non-terminal) workflows', s.active),
        g('workflow_latency_ms_avg', 'Average operation latency', s.avgLatencyMs),
        g('workflow_latency_ms_last', 'Last operation latency', s.lastLatencyMs),
        g(
          'workflow_transition_latency_ms_avg',
          'Average transition latency',
          s.avgTransitionLatencyMs
        ),
        g('workflow_duration_ms_avg', 'Average workflow duration', s.avgWorkflowDurationMs),
        g(
          'workflow_scheduler_reconciliations_total',
          'Scheduler reconciliations',
          s.schedulerReconciliations
        ),
        g('workflow_lock_conflicts_total', 'Lock conflicts', s.lockConflicts),
        g('workflow_storage_failures_total', 'Storage failures', s.storageFailures),
        g(
          'workflow_event_publication_failures_total',
          'Event publication failures',
          s.eventPublicationFailures
        ),
      ].join('\n') + '\n'
    );
  }

  return {
    recordStart,
    recordCompleted,
    recordFailed,
    recordCancelled,
    recordTransition,
    recordTimeout,
    recordLatency,
    recordSchedulerReconciliation,
    recordLockConflict,
    recordStorageFailure,
    recordEventFailure,
    recordTransitionLatency,
    recordWorkflowDuration,
    timeOp,
    snapshot,
    prometheus,
  };
}

module.exports = { createWorkflowMetrics };
