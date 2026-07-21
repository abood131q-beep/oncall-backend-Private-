'use strict';

/**
 * Resilience metrics (Phase 15.7 / ADR-036 §8) — observability port. Tracks
 * registered policies (gauge), protected + successful + failed executions, retry
 * attempts, fallback executions, open + closed circuits (gauges), timeouts, provider
 * failures, and engine uptime; exposes a Prometheus exposition. Pure in-process
 * counters; an injectable clock keeps uptime deterministic.
 */

function createResilienceMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let executions = 0;
  let successes = 0;
  let failures = 0;
  let retries = 0;
  let fallbacks = 0;
  let timeouts = 0;
  let bulkheadRejections = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;

  let gaugePolicies = () => 0;
  let gaugeOpen = () => 0;
  let gaugeClosed = () => 0;
  function bindGauges({ policies, openCircuits, closedCircuits }) {
    if (policies) gaugePolicies = policies;
    if (openCircuits) gaugeOpen = openCircuits;
    if (closedCircuits) gaugeClosed = closedCircuits;
  }

  const recordExecution = () => (executions += 1);
  const recordSuccess = () => (successes += 1);
  const recordFailure = () => (failures += 1);
  const recordRetry = () => (retries += 1);
  const recordFallback = () => (fallbacks += 1);
  const recordTimeout = () => (timeouts += 1);
  const recordBulkheadRejection = () => (bulkheadRejections += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);

  function snapshot() {
    return {
      registeredPolicies: gaugePolicies(),
      protectedExecutions: executions,
      successfulExecutions: successes,
      failedExecutions: failures,
      retryAttempts: retries,
      fallbackExecutions: fallbacks,
      openCircuits: gaugeOpen(),
      closedCircuits: gaugeClosed(),
      timeouts,
      bulkheadRejections,
      providerFailures,
      eventFailures,
      integrityFailures,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('resilience_registered_policies', 'Registered policies', s.registeredPolicies),
        g('resilience_protected_executions_total', 'Protected executions', s.protectedExecutions),
        g(
          'resilience_successful_executions_total',
          'Successful executions',
          s.successfulExecutions
        ),
        g('resilience_failed_executions_total', 'Failed executions', s.failedExecutions),
        g('resilience_retry_attempts_total', 'Retry attempts', s.retryAttempts),
        g('resilience_fallback_executions_total', 'Fallback executions', s.fallbackExecutions),
        g('resilience_open_circuits', 'Open circuits', s.openCircuits),
        g('resilience_closed_circuits', 'Closed circuits', s.closedCircuits),
        g('resilience_timeouts_total', 'Execution timeouts', s.timeouts),
        g('resilience_bulkhead_rejections_total', 'Bulkhead rejections', s.bulkheadRejections),
        g('resilience_provider_failures_total', 'Provider failures', s.providerFailures),
        g('resilience_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'resilience_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('resilience_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordExecution,
    recordSuccess,
    recordFailure,
    recordRetry,
    recordFallback,
    recordTimeout,
    recordBulkheadRejection,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    snapshot,
    prometheus,
  };
}

module.exports = { createResilienceMetrics };
