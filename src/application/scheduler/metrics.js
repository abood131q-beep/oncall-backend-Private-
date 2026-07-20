'use strict';

/**
 * Scheduler metrics (Phase 14.3.3 §7) — observability port. Tracks jobs
 * scheduled/running/completed/failed, retry count, execution duration, queue
 * depth, and worker utilization; exposes a Prometheus exposition. Pure
 * in-process counters + injectable gauges (queue depth, running) read on demand.
 */

function createSchedulerMetrics(opts = {}) {
  let scheduled = 0;
  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let retries = 0;
  let durTotalMs = 0;
  let durCount = 0;
  let lastDurMs = 0;
  const concurrency = opts.concurrency || 1;

  // Production hardening (Phase 14.3.3 A-001) — additive counters/gauges.
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let qLatTotalMs = 0;
  let qLatCount = 0;
  let qLatLastMs = 0;

  // Gauges supplied by the engine at snapshot time.
  let gaugeRunning = () => 0;
  let gaugeQueueDepth = () => 0;
  let gaugeDeadLetter = () => 0;
  function bindGauges({ running, queueDepth, deadLetterSize }) {
    if (running) gaugeRunning = running;
    if (queueDepth) gaugeQueueDepth = queueDepth;
    if (deadLetterSize) gaugeDeadLetter = deadLetterSize;
  }

  /** Time a job waited between becoming due (nextRun) and starting. */
  function recordQueueLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      qLatTotalMs += ms;
      qLatCount += 1;
      qLatLastMs = ms;
    }
  }

  const recordScheduled = () => (scheduled += 1);
  const recordCompleted = (ms) => {
    completed += 1;
    if (typeof ms === 'number') {
      durTotalMs += ms;
      durCount += 1;
      lastDurMs = ms;
    }
  };
  const recordFailed = () => (failed += 1);
  const recordTimedOut = () => (timedOut += 1);
  const recordCancelled = () => (cancelled += 1);
  const recordRetry = () => (retries += 1);

  function snapshot() {
    const running = gaugeRunning();
    return {
      scheduled,
      running,
      completed,
      failed,
      timedOut,
      cancelled,
      retries,
      avgDurationMs: durCount ? durTotalMs / durCount : 0,
      lastDurationMs: lastDurMs,
      queueDepth: gaugeQueueDepth(),
      workerUtilization: concurrency ? running / concurrency : 0,
      concurrency,
      // A-001 additions
      queued: gaugeQueueDepth(),
      queueLatencyAvgMs: qLatCount ? qLatTotalMs / qLatCount : 0,
      queueLatencyLastMs: qLatLastMs,
      deadLetterSize: gaugeDeadLetter(),
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('scheduler_jobs_scheduled_total', 'Jobs scheduled', s.scheduled),
        g('scheduler_jobs_running', 'Jobs currently running', s.running),
        g('scheduler_jobs_completed_total', 'Jobs completed', s.completed),
        g('scheduler_jobs_failed_total', 'Jobs failed (dead-lettered)', s.failed),
        g('scheduler_jobs_timed_out_total', 'Jobs timed out', s.timedOut),
        g('scheduler_jobs_cancelled_total', 'Jobs cancelled', s.cancelled),
        g('scheduler_retries_total', 'Retry attempts', s.retries),
        g('scheduler_execution_duration_ms_avg', 'Avg execution duration', s.avgDurationMs),
        g('scheduler_execution_duration_ms_last', 'Last execution duration', s.lastDurationMs),
        g('scheduler_queue_depth', 'Due jobs waiting for a worker', s.queueDepth),
        g('scheduler_jobs_queued', 'Jobs currently queued (ready set depth)', s.queued),
        g('scheduler_worker_utilization', 'running / concurrency', s.workerUtilization),
        g('scheduler_queue_latency_ms_avg', 'Avg wait from due to start', s.queueLatencyAvgMs),
        g('scheduler_queue_latency_ms_last', 'Last wait from due to start', s.queueLatencyLastMs),
        g('scheduler_dead_letter_size', 'Dead-lettered jobs', s.deadLetterSize),
        g('scheduler_uptime_ms', 'Scheduler uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordScheduled,
    recordCompleted,
    recordFailed,
    recordTimedOut,
    recordCancelled,
    recordRetry,
    recordQueueLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createSchedulerMetrics };
