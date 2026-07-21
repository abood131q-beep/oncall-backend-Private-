'use strict';

/**
 * Lifecycle Management metrics (Phase 15.11 / ADR-040 §8) — observability port. Tracks
 * registered / started (gauges) + initialized / stopped components, restart
 * operations, failed transitions, startup + shutdown latency, provider failures, and
 * engine uptime; exposes a Prometheus exposition. Pure in-process counters; an
 * injectable clock keeps latency + uptime deterministic.
 */

function createLifecycleMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let initialized = 0;
  let started = 0;
  let stopped = 0;
  let restarts = 0;
  let failedTransitions = 0;
  let verifications = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let startupTotalMs = 0;
  let startupCount = 0;
  let startupLastMs = 0;
  let shutdownTotalMs = 0;
  let shutdownCount = 0;
  let shutdownLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeStarted = () => 0;
  function bindGauges({ registered, running }) {
    if (registered) gaugeRegistered = registered;
    if (running) gaugeStarted = running;
  }

  const recordInitialized = () => (initialized += 1);
  const recordStarted = () => (started += 1);
  const recordStopped = () => (stopped += 1);
  const recordRestart = () => (restarts += 1);
  const recordFailedTransition = () => (failedTransitions += 1);
  const recordVerification = () => (verifications += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  function recordStartupLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      startupTotalMs += ms;
      startupCount += 1;
      startupLastMs = ms;
    }
  }
  function recordShutdownLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      shutdownTotalMs += ms;
      shutdownCount += 1;
      shutdownLastMs = ms;
    }
  }

  function snapshot() {
    return {
      registeredComponents: gaugeRegistered(),
      startedComponents: gaugeStarted(),
      initializedComponents: initialized,
      stoppedComponents: stopped,
      restartOperations: restarts,
      failedTransitions,
      verifications,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgStartupLatencyMs: startupCount ? startupTotalMs / startupCount : 0,
      lastStartupLatencyMs: startupLastMs,
      avgShutdownLatencyMs: shutdownCount ? shutdownTotalMs / shutdownCount : 0,
      lastShutdownLatencyMs: shutdownLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('lifecycle_registered_components', 'Registered components', s.registeredComponents),
        g('lifecycle_started_components', 'Started components', s.startedComponents),
        g('lifecycle_initialized_total', 'Initialized components', s.initializedComponents),
        g('lifecycle_stopped_total', 'Stopped components', s.stoppedComponents),
        g('lifecycle_restart_operations_total', 'Restart operations', s.restartOperations),
        g('lifecycle_failed_transitions_total', 'Failed transitions', s.failedTransitions),
        g('lifecycle_verifications_total', 'Verification runs', s.verifications),
        g('lifecycle_provider_failures_total', 'Provider failures', s.providerFailures),
        g('lifecycle_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'lifecycle_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('lifecycle_startup_latency_ms_avg', 'Average startup latency', s.avgStartupLatencyMs),
        g('lifecycle_startup_latency_ms_last', 'Last startup latency', s.lastStartupLatencyMs),
        g('lifecycle_shutdown_latency_ms_avg', 'Average shutdown latency', s.avgShutdownLatencyMs),
        g('lifecycle_shutdown_latency_ms_last', 'Last shutdown latency', s.lastShutdownLatencyMs),
        g('lifecycle_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordInitialized,
    recordStarted,
    recordStopped,
    recordRestart,
    recordFailedTransition,
    recordVerification,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordStartupLatency,
    recordShutdownLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createLifecycleMetrics };
