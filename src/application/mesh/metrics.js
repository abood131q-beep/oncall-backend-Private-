'use strict';

/**
 * Service Mesh metrics (Phase 15.8 / ADR-037 §8) — observability port. Tracks
 * registered + active connections (gauges), invocations, successful + failed
 * invocations, policy violations, provider failures, connection latency, and engine
 * uptime; exposes a Prometheus exposition. Pure in-process counters; an injectable
 * clock keeps latency + uptime deterministic.
 */

function createMeshMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let invocations = 0;
  let successes = 0;
  let failures = 0;
  let policyViolations = 0;
  let established = 0;
  let closed = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeRegistered = () => 0;
  let gaugeActive = () => 0;
  function bindGauges({ registered, active }) {
    if (registered) gaugeRegistered = registered;
    if (active) gaugeActive = active;
  }

  const recordInvocation = () => (invocations += 1);
  const recordSuccess = () => (successes += 1);
  const recordFailure = () => (failures += 1);
  const recordPolicyViolation = () => (policyViolations += 1);
  const recordEstablished = () => (established += 1);
  const recordClosed = () => (closed += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      registeredConnections: gaugeRegistered(),
      activeConnections: gaugeActive(),
      invocations,
      successfulInvocations: successes,
      failedInvocations: failures,
      policyViolations,
      established,
      closed,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgConnectionLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastConnectionLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('mesh_registered_connections', 'Registered connections', s.registeredConnections),
        g('mesh_active_connections', 'Active (established) connections', s.activeConnections),
        g('mesh_invocations_total', 'Invocations', s.invocations),
        g('mesh_invocations_success_total', 'Successful invocations', s.successfulInvocations),
        g('mesh_invocations_failed_total', 'Failed invocations', s.failedInvocations),
        g('mesh_policy_violations_total', 'Policy violations', s.policyViolations),
        g('mesh_provider_failures_total', 'Provider failures', s.providerFailures),
        g('mesh_event_failures_total', 'Event publication failures', s.eventFailures),
        g('mesh_integrity_failures_total', 'Integrity verification failures', s.integrityFailures),
        g('mesh_connection_latency_ms_avg', 'Average connection latency', s.avgConnectionLatencyMs),
        g('mesh_connection_latency_ms_last', 'Last connection latency', s.lastConnectionLatencyMs),
        g('mesh_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordInvocation,
    recordSuccess,
    recordFailure,
    recordPolicyViolation,
    recordEstablished,
    recordClosed,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createMeshMetrics };
