'use strict';

/**
 * Observability Adapter — Phase 17.4.
 *
 * The ONLY component permitted to talk to the Observability Kernel (ADR-033). It is a pure
 * TRANSLATION layer between the legacy OnCall observation shape and the kernel's public
 * service (`register / collect / snapshot / health`). It contains NO business logic and never
 * touches repositories, the database, or application services.
 *
 * SHADOW POSTURE: even when a kernel port is injected (PLATFORM_OBSERVABILITY=1) this adapter
 * is NON-AUTHORITATIVE. It records a copy of the legacy observation into the kernel and reads
 * it back solely so the shadow verifier can compare — the kernel's view is NEVER returned to
 * the application, and the legacy observability system stays the source of truth.
 *
 * Round-trip encoding (deterministic + lossless): categorical values (health status, per-
 * check states, readiness/liveness booleans) are encoded as numeric gauges the kernel stores
 * exactly (gauges SET), then decoded back to the original representation on read. Numeric
 * counters/gauges/timers pass through unchanged (a FRESH component per pass ⇒ no counter
 * accumulation).
 */

const { requirePort } = require('../_base');

// ── deterministic, lossless codecs (pure translation) ────────────────────────────
const STATUS_ENCODE = {
  ok: 'healthy',
  healthy: 'healthy',
  degraded: 'degraded',
  unhealthy: 'failed',
  failed: 'failed',
  unknown: 'unknown',
};
const STATUS_DECODE = {
  healthy: 'ok',
  degraded: 'degraded',
  failed: 'unhealthy',
  unknown: 'unknown',
};
const CHECK_ENCODE = { ok: 0, warning: 1, error: 2, down: 2 };
const CHECK_DECODE = { 0: 'ok', 1: 'warning', 2: 'error' };

/** Encode a full legacy observation into a kernel `register` spec + `collect` report. */
function toKernelSpec(obs = {}, service) {
  const health = obs.health || {};
  const checks = health.checks || {};
  const gauges = { ...(obs.gauges || {}) };
  for (const [name, state] of Object.entries(checks)) {
    gauges[`check.${name}`] = CHECK_ENCODE[state] ?? 3; // categorical → numeric (lossless)
  }
  gauges['readiness.ready'] = obs.readiness && obs.readiness.ready ? 1 : 0;
  gauges['liveness.live'] = obs.liveness && obs.liveness.live ? 1 : 0;
  return {
    service: service || (obs.event && obs.event.service) || 'oncall',
    health: STATUS_ENCODE[health.status] || 'unknown',
    counters: { ...(obs.counters || {}) },
    gauges,
    timers: { ...(obs.timers || {}) },
    // categorical/string metadata rides on the component metadata (round-trips exactly):
    // health tags, event metadata, and structured-log metadata.
    metadata: {
      tags: { ...(health.tags || {}) },
      event: { ...(obs.event || {}) },
      log: { ...(obs.log || {}) },
    },
  };
}

/** Decode a kernel component model back into the legacy observation shape. */
function fromKernelModel(model = {}) {
  const gauges = { ...(model.gauges || {}) };
  const meta = model.metadata || {};
  const checks = {};
  const plainGauges = {};
  for (const [k, v] of Object.entries(gauges)) {
    if (k.startsWith('check.')) checks[k.slice('check.'.length)] = CHECK_DECODE[v] ?? 'unknown';
    else if (k === 'readiness.ready' || k === 'liveness.live') continue;
    else plainGauges[k] = v;
  }
  const timers = {};
  for (const [k, t] of Object.entries(model.timers || {})) {
    timers[k] = t && typeof t === 'object' ? t.lastMs : t; // compare the last observed value
  }
  return {
    health: {
      status: STATUS_DECODE[model.healthStatus] || 'unknown',
      checks,
      tags: meta.tags || {},
    },
    readiness: { ready: gauges['readiness.ready'] === 1 },
    liveness: { live: gauges['liveness.live'] === 1 },
    counters: { ...(model.counters || {}) },
    gauges: plainGauges,
    timers,
    event: meta.event || { service: model.service },
    log: meta.log || {},
  };
}

function createObservabilityAdapter({ port = null, componentPrefix = 'oncall-obs' } = {}) {
  let seq = 0;

  return Object.freeze({
    name: 'observability',
    kernel: 'observability (ADR-033)',
    consumed: () => port != null,

    // ── pure translation (shape-only) ───────────────────────────────────────────
    toKernelSpec,
    fromKernelModel,

    // ── active reads/writes (require an injected Observability kernel port) ──────
    /** Record a legacy observation into the kernel under a FRESH component; returns its id. */
    async record(obs) {
      const p = requirePort('observability', port);
      const componentId = `${componentPrefix}-${++seq}`;
      const report = toKernelSpec(obs, obs.event && obs.event.service);
      await p.register({ componentId, service: report.service, metadata: report.metadata });
      await p.collect({
        componentId,
        health: report.health,
        counters: report.counters,
        gauges: report.gauges,
        timers: report.timers,
      });
      return componentId;
    },
    /** Read a previously recorded component back, decoded to the legacy observation shape. */
    async readComponent(componentId) {
      const p = requirePort('observability', port);
      const snap = await p.snapshot({});
      const model = (snap.components || []).find((c) => c.componentId === componentId);
      return model ? fromKernelModel(model) : null;
    },

    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createObservabilityAdapter, toKernelSpec, fromKernelModel };
