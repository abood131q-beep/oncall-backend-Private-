'use strict';

/**
 * Audit metrics (Phase 14.7 / ADR-026 §7) — observability port. Tracks records
 * written, queries executed, verification failures, checksum failures, provider
 * failures, and query latency; exposes a Prometheus exposition. Pure in-process
 * counters; injectable clock keeps latency + uptime deterministic.
 */

function createAuditMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let written = 0;
  let queries = 0;
  let verifications = 0;
  let verificationFailures = 0;
  let checksumFailures = 0;
  let integrityFailures = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  const recordWritten = () => (written += 1);
  const recordQuery = () => (queries += 1);
  const recordVerification = (ok) => {
    verifications += 1;
    if (!ok) verificationFailures += 1;
  };
  const recordChecksumFailure = () => (checksumFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  function recordQueryLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      written,
      queries,
      verifications,
      verificationFailures,
      checksumFailures,
      integrityFailures,
      providerFailures,
      eventFailures,
      avgQueryLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastQueryLatencyMs: latLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('audit_records_written_total', 'Audit records written', s.written),
        g('audit_queries_total', 'Queries executed', s.queries),
        g('audit_verifications_total', 'Verifications run', s.verifications),
        g('audit_verification_failures_total', 'Verification failures', s.verificationFailures),
        g('audit_checksum_failures_total', 'Checksum failures', s.checksumFailures),
        g(
          'audit_integrity_failures_total',
          'Integrity (chain/sequence) failures',
          s.integrityFailures
        ),
        g('audit_provider_failures_total', 'Provider failures', s.providerFailures),
        g('audit_event_failures_total', 'Event publication failures', s.eventFailures),
        g('audit_query_latency_ms_avg', 'Average query latency', s.avgQueryLatencyMs),
        g('audit_query_latency_ms_last', 'Last query latency', s.lastQueryLatencyMs),
        g('audit_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    recordWritten,
    recordQuery,
    recordVerification,
    recordChecksumFailure,
    recordIntegrityFailure,
    recordProviderFailure,
    recordEventFailure,
    recordQueryLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createAuditMetrics };
