'use strict';

/**
 * Lock metrics (Phase 14.3.5 §7) — observability port. Tracks locks acquired,
 * released, renewals, expirations, conflicts, average lease (held) duration, and
 * operation latency; exposes a Prometheus exposition. Pure in-process counters;
 * injectable clock keeps latency deterministic.
 */

function createLockMetrics(opts = {}) {
  const now = opts.clock || (() => Date.now());
  let acquired = 0;
  let released = 0;
  let renewals = 0;
  let expirations = 0;
  let conflicts = 0;
  let heldTotalMs = 0;
  let heldCount = 0;
  let latTotalMs = 0;
  let latCount = 0;
  let latLastMs = 0;

  const recordAcquire = () => (acquired += 1);
  const recordRelease = () => (released += 1);
  const recordRenew = () => (renewals += 1);
  const recordExpiration = () => (expirations += 1);
  const recordConflict = () => (conflicts += 1);
  function recordHeldDuration(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      heldTotalMs += ms;
      heldCount += 1;
    }
  }
  function recordLatency(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      latTotalMs += ms;
      latCount += 1;
      latLastMs = ms;
    }
  }
  async function timeOp(fn) {
    const start = now();
    try {
      return await fn();
    } finally {
      recordLatency(now() - start);
    }
  }

  function snapshot() {
    return {
      acquired,
      released,
      renewals,
      expirations,
      conflicts,
      avgLeaseDurationMs: heldCount ? heldTotalMs / heldCount : 0,
      avgLatencyMs: latCount ? latTotalMs / latCount : 0,
      lastLatencyMs: latLastMs,
    };
  }

  function prometheus() {
    const s = snapshot();
    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
    return (
      [
        g('lock_acquired_total', 'Locks acquired', s.acquired),
        g('lock_released_total', 'Locks released', s.released),
        g('lock_renewals_total', 'Lease renewals', s.renewals),
        g('lock_expirations_total', 'Lease expirations', s.expirations),
        g('lock_conflicts_total', 'Acquisition conflicts', s.conflicts),
        g('lock_lease_duration_ms_avg', 'Average held lease duration', s.avgLeaseDurationMs),
        g('lock_latency_ms_avg', 'Average operation latency', s.avgLatencyMs),
        g('lock_latency_ms_last', 'Last operation latency', s.lastLatencyMs),
      ].join('\n') + '\n'
    );
  }

  return {
    recordAcquire,
    recordRelease,
    recordRenew,
    recordExpiration,
    recordConflict,
    recordHeldDuration,
    recordLatency,
    timeOp,
    snapshot,
    prometheus,
  };
}

module.exports = { createLockMetrics };
