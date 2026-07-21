'use strict';

/**
 * Resource Management metrics (Phase 15.10 / ADR-039 §8) — observability port. Tracks
 * registered resources + active allocations (gauges), released allocations, quota
 * violations, allocation latency, resource utilization (gauge), provider failures,
 * verification runs, and engine uptime; exposes a Prometheus exposition. Pure
 * in-process counters; an injectable clock keeps latency + uptime deterministic.
 */

function createResourceMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let allocations = 0;
  let released = 0;
  let quotaViolations = 0;
  let conflicts = 0;
  let preemptions = 0;
  let verifications = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeResources = () => 0;
  let gaugeActive = () => 0;
  let gaugeUtilization = () => 0;
  function bindGauges({ resources, active, utilization }) {
    if (resources) gaugeResources = resources;
    if (active) gaugeActive = active;
    if (utilization) gaugeUtilization = utilization;
  }

  const recordAllocation = () => (allocations += 1);
  const recordRelease = () => (released += 1);
  const recordQuotaViolation = () => (quotaViolations += 1);
  const recordConflict = () => (conflicts += 1);
  const recordPreemption = () => (preemptions += 1);
  const recordVerification = () => (verifications += 1);
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
      registeredResources: gaugeResources(),
      activeAllocations: gaugeActive(),
      releasedAllocations: released,
      allocations,
      quotaViolations,
      conflicts,
      preemptions,
      verifications,
      resourceUtilization: gaugeUtilization(),
      providerFailures,
      eventFailures,
      integrityFailures,
      avgAllocationLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastAllocationLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('resources_registered_total', 'Registered resources', s.registeredResources),
        g('resources_active_allocations', 'Active allocations', s.activeAllocations),
        g('resources_released_allocations_total', 'Released allocations', s.releasedAllocations),
        g('resources_allocations_total', 'Allocations made', s.allocations),
        g('resources_quota_violations_total', 'Quota violations', s.quotaViolations),
        g('resources_conflicts_total', 'Allocation conflicts', s.conflicts),
        g('resources_preemptions_total', 'Preemptions', s.preemptions),
        g('resources_verifications_total', 'Verification runs', s.verifications),
        g('resources_utilization_ratio', 'Aggregate resource utilization', s.resourceUtilization),
        g('resources_provider_failures_total', 'Provider failures', s.providerFailures),
        g('resources_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'resources_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g(
          'resources_allocation_latency_ms_avg',
          'Average allocation latency',
          s.avgAllocationLatencyMs
        ),
        g(
          'resources_allocation_latency_ms_last',
          'Last allocation latency',
          s.lastAllocationLatencyMs
        ),
        g('resources_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordAllocation,
    recordRelease,
    recordQuotaViolation,
    recordConflict,
    recordPreemption,
    recordVerification,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createResourceMetrics };
