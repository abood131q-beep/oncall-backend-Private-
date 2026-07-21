'use strict';

/**
 * Background Jobs metrics (Phase 15.3 / ADR-032 §8) — observability port. Tracks
 * registered job types (gauge), queued / running / dead-letter jobs (gauges),
 * completed / failed / retried jobs (counters), execution latency, provider
 * failures, and engine uptime; exposes a Prometheus exposition. Pure in-process
 * counters; an injectable clock keeps latency + uptime deterministic.
 */

function createJobsMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let enqueued = 0;
  let completed = 0;
  let failed = 0;
  let retried = 0;
  let cancelled = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let duplicates = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeQueued = () => 0;
  let gaugeRunning = () => 0;
  let gaugeDeadLetter = () => 0;
  function bindGauges({ registered, queued, running, deadLetter }) {
    if (registered) gaugeRegistered = registered;
    if (queued) gaugeQueued = queued;
    if (running) gaugeRunning = running;
    if (deadLetter) gaugeDeadLetter = deadLetter;
  }

  const recordEnqueued = () => (enqueued += 1);
  const recordCompleted = () => (completed += 1);
  const recordFailed = () => (failed += 1);
  const recordRetried = () => (retried += 1);
  const recordCancelled = () => (cancelled += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  const recordDuplicate = () => (duplicates += 1);
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      registeredJobs: gaugeRegistered(),
      queuedJobs: gaugeQueued(),
      runningJobs: gaugeRunning(),
      deadLetterJobs: gaugeDeadLetter(),
      enqueued,
      completed,
      failed,
      retried,
      cancelled,
      duplicates,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('jobs_registered_types', 'Registered job types', s.registeredJobs),
        g('jobs_queued', 'Queued jobs', s.queuedJobs),
        g('jobs_running', 'Running jobs', s.runningJobs),
        g('jobs_dead_letter', 'Dead-letter jobs', s.deadLetterJobs),
        g('jobs_enqueued_total', 'Enqueued jobs', s.enqueued),
        g('jobs_completed_total', 'Completed jobs', s.completed),
        g('jobs_failed_total', 'Failed job attempts', s.failed),
        g('jobs_retried_total', 'Retried jobs', s.retried),
        g('jobs_cancelled_total', 'Cancelled jobs', s.cancelled),
        g('jobs_duplicates_total', 'Deduplicated enqueues', s.duplicates),
        g('jobs_provider_failures_total', 'Provider failures', s.providerFailures),
        g('jobs_event_failures_total', 'Event publication failures', s.eventFailures),
        g('jobs_integrity_failures_total', 'Integrity verification failures', s.integrityFailures),
        g('jobs_execution_latency_ms_avg', 'Average execution latency', s.avgLatencyMs),
        g('jobs_execution_latency_ms_last', 'Last execution latency', s.lastLatencyMs),
        g('jobs_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordEnqueued,
    recordCompleted,
    recordFailed,
    recordRetried,
    recordCancelled,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordDuplicate,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createJobsMetrics };
