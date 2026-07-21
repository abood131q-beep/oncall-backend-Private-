'use strict';

/**
 * Compatibility Kernel metrics (Phase 15.12 / ADR-041 §8) — observability port. Tracks
 * registered contracts (gauge), compatibility evaluations + incompatible outcomes,
 * verifications, capability negotiations, deprecations, detected violations, provider /
 * event / integrity failures, evaluation latency, and engine uptime; exposes a
 * Prometheus exposition. Pure in-process counters; an injectable clock keeps latency +
 * uptime deterministic.
 */

function createCompatibilityMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let evaluations = 0;
  let incompatible = 0;
  let verifications = 0;
  let negotiations = 0;
  let deprecations = 0;
  let violations = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let evalTotalMs = 0;
  let evalCount = 0;
  let evalLastMs = 0;

  let gaugeContracts = () => 0;
  function bindGauges({ contracts }) {
    if (contracts) gaugeContracts = contracts;
  }

  const recordEvaluation = () => (evaluations += 1);
  const recordIncompatible = () => (incompatible += 1);
  const recordVerification = () => (verifications += 1);
  const recordNegotiation = () => (negotiations += 1);
  const recordDeprecation = () => (deprecations += 1);
  const recordViolation = () => (violations += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  function recordEvaluationLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      evalTotalMs += ms;
      evalCount += 1;
      evalLastMs = ms;
    }
  }

  function snapshot() {
    return {
      registeredContracts: gaugeContracts(),
      evaluations,
      incompatibleResults: incompatible,
      verifications,
      negotiations,
      deprecations,
      violationsDetected: violations,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgEvaluationLatencyMs: evalCount ? evalTotalMs / evalCount : 0,
      lastEvaluationLatencyMs: evalLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('compatibility_registered_contracts', 'Registered contracts', s.registeredContracts),
        g('compatibility_evaluations_total', 'Compatibility evaluations', s.evaluations),
        g('compatibility_incompatible_total', 'Incompatible outcomes', s.incompatibleResults),
        g('compatibility_verifications_total', 'Verification runs', s.verifications),
        g('compatibility_negotiations_total', 'Capability negotiations', s.negotiations),
        g('compatibility_deprecations_total', 'Version deprecations', s.deprecations),
        g(
          'compatibility_violations_total',
          'Compatibility violations detected',
          s.violationsDetected
        ),
        g('compatibility_provider_failures_total', 'Provider failures', s.providerFailures),
        g('compatibility_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'compatibility_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g(
          'compatibility_eval_latency_ms_avg',
          'Average evaluation latency',
          s.avgEvaluationLatencyMs
        ),
        g(
          'compatibility_eval_latency_ms_last',
          'Last evaluation latency',
          s.lastEvaluationLatencyMs
        ),
        g('compatibility_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordEvaluation,
    recordIncompatible,
    recordVerification,
    recordNegotiation,
    recordDeprecation,
    recordViolation,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordEvaluationLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createCompatibilityMetrics };
