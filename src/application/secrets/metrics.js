'use strict';

/**
 * Secrets metrics (Phase 14.9 / ADR-028 §7) — observability port. Tracks stored
 * secrets (gauge), rotations, resolutions, provider failures, rotation latency,
 * and engine uptime; exposes a Prometheus exposition. Pure in-process counters;
 * an injectable clock keeps latency + uptime deterministic. Values are NEVER
 * recorded — only counts and timings.
 */

function createSecretsMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let stored = 0;
  let rotations = 0;
  let resolutions = 0;
  let deletions = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let integrityFailures = 0;
  let rotTotalMs = 0;
  let rotCount = 0;
  let rotLastMs = 0;

  let gaugeStoredSecrets = () => 0;
  function bindGauges({ storedSecrets }) {
    if (storedSecrets) gaugeStoredSecrets = storedSecrets;
  }

  const recordStored = () => (stored += 1);
  const recordRotation = () => (rotations += 1);
  const recordResolution = () => (resolutions += 1);
  const recordDeletion = () => (deletions += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  const recordIntegrityFailure = () => (integrityFailures += 1);
  function recordRotationLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      rotTotalMs += ms;
      rotCount += 1;
      rotLastMs = ms;
    }
  }

  function snapshot() {
    return {
      stored,
      storedSecrets: gaugeStoredSecrets(),
      rotations,
      resolutions,
      deletions,
      providerFailures,
      eventFailures,
      integrityFailures,
      avgRotationLatencyMs: rotCount ? rotTotalMs / rotCount : 0,
      lastRotationLatencyMs: rotLastMs,
      uptimeMs: clock() - startedAt,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('secrets_stored_total', 'Secrets stored (created)', s.stored),
        g('secrets_stored_secrets', 'Current stored secrets', s.storedSecrets),
        g('secrets_rotations_total', 'Secret rotations', s.rotations),
        g('secrets_resolutions_total', 'Secret resolutions', s.resolutions),
        g('secrets_deletions_total', 'Secret deletions', s.deletions),
        g('secrets_provider_failures_total', 'Provider failures', s.providerFailures),
        g('secrets_event_failures_total', 'Event publication failures', s.eventFailures),
        g(
          'secrets_integrity_failures_total',
          'Integrity verification failures',
          s.integrityFailures
        ),
        g('secrets_rotation_latency_ms_avg', 'Average rotation latency', s.avgRotationLatencyMs),
        g('secrets_rotation_latency_ms_last', 'Last rotation latency', s.lastRotationLatencyMs),
        g('secrets_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordStored,
    recordRotation,
    recordResolution,
    recordDeletion,
    recordProviderFailure,
    recordEventFailure,
    recordIntegrityFailure,
    recordRotationLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createSecretsMetrics };
