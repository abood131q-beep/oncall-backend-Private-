'use strict';

/**
 * Identity metrics (Phase 14.8 / ADR-027 §7) — observability port. Tracks
 * identities, active sessions, authentication attempts/failures, refreshes,
 * revocations, provider failures, and latency; exposes a Prometheus exposition.
 * Pure in-process counters; injectable clock keeps latency + uptime deterministic.
 */

function createIdentityMetrics(opts = {}) {
  const clock = opts.clock || (() => Date.now());
  const startedAt = clock();
  let identities = 0;
  let authAttempts = 0;
  let authFailures = 0;
  let refreshes = 0;
  let revocations = 0;
  let providerFailures = 0;
  let eventFailures = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  let gaugeActiveSessions = () => 0;
  function bindGauges({ activeSessions }) {
    if (activeSessions) gaugeActiveSessions = activeSessions;
  }

  const recordIdentity = () => (identities += 1);
  const recordAuthAttempt = () => (authAttempts += 1);
  const recordAuthFailure = () => (authFailures += 1);
  const recordRefresh = () => (refreshes += 1);
  const recordRevocation = () => (revocations += 1);
  const recordProviderFailure = () => (providerFailures += 1);
  const recordEventFailure = () => (eventFailures += 1);
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }

  function snapshot() {
    return {
      identities,
      activeSessions: gaugeActiveSessions(),
      authAttempts,
      authFailures,
      refreshes,
      revocations,
      providerFailures,
      eventFailures,
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
        g('identity_identities_total', 'Registered identities', s.identities),
        g('identity_active_sessions', 'Active sessions', s.activeSessions),
        g('identity_auth_attempts_total', 'Authentication attempts', s.authAttempts),
        g('identity_auth_failures_total', 'Authentication failures', s.authFailures),
        g('identity_refreshes_total', 'Session refreshes', s.refreshes),
        g('identity_revocations_total', 'Session revocations', s.revocations),
        g('identity_provider_failures_total', 'Provider failures', s.providerFailures),
        g('identity_event_failures_total', 'Event publication failures', s.eventFailures),
        g('identity_latency_ms_avg', 'Average operation latency', s.avgLatencyMs),
        g('identity_latency_ms_last', 'Last operation latency', s.lastLatencyMs),
        g('identity_uptime_ms', 'Engine uptime', s.uptimeMs),
      ].join('\n') + '\n'
    );
  }

  return {
    bindGauges,
    recordIdentity,
    recordAuthAttempt,
    recordAuthFailure,
    recordRefresh,
    recordRevocation,
    recordProviderFailure,
    recordEventFailure,
    recordLatency,
    snapshot,
    prometheus,
  };
}

module.exports = { createIdentityMetrics };
