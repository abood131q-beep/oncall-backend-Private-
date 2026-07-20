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

  const recordStart = () => (started += 1);
  const recordCompleted = () => (completed += 1);
  const recordFailed = () => (failed += 1);
  const recordCancelled = () => (cancelled += 1);
  const recordTransition = () => (transitions += 1);
  const recordTimeout = () => (timeouts += 1);
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
    timeOp,
    snapshot,
    prometheus,
  };
}

module.exports = { createWorkflowMetrics };
