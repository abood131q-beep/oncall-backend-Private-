'use strict';

/**
 * Component (Phase 15.4 / ADR-033 §2) — PURE domain value object. A registered
 * unit of the platform reporting health + telemetry to the Observability Kernel.
 * This is NOT Prometheus/OpenTelemetry/Grafana/Datadog — those are export-provider
 * extension points. Behavior (aggregation, snapshots, diagnostics) lives in the
 * engine; this object owns identity, its metric registers, and its report merges.
 *
 * Fields: componentId, namespace, service, healthStatus, counters, gauges, timers,
 * traceContext, metadata, version, checksum, timestamp.
 */

const { ObservabilityValidationError } = require('./errors');
const { checksum } = require('../extensions/integrity');
const { HEALTH, normalize } = require('./health');

let _seq = 0;
function defaultId() {
  _seq = (_seq + 1) % 1e6;
  return `cmp_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function definitionOf(c) {
  return {
    componentId: c.componentId,
    namespace: c.namespace,
    service: c.service,
    healthStatus: c.healthStatus,
    counters: c.counters,
    gauges: c.gauges,
    timers: c.timers,
    traceContext: c.traceContext,
    metadata: c.metadata,
  };
}

function computeChecksum(c) {
  return checksum(stableStringify(definitionOf(c)));
}

/**
 * @param {object} spec { componentId?, service (required), namespace?, healthStatus?,
 *   counters?, gauges?, timers?, traceContext?, metadata?, version?, timestamp? }
 * @param {object} [opts] { idFactory, clock }
 */
function createComponent(spec = {}, opts = {}) {
  const idFactory = opts.idFactory || defaultId;
  const clock = opts.clock || (() => Date.now());
  if (!spec.service || typeof spec.service !== 'string') {
    throw new ObservabilityValidationError('component: "service" is required');
  }
  const now = clock();
  const c = {
    componentId: spec.componentId || idFactory(),
    namespace: spec.namespace || 'default',
    service: spec.service,
    healthStatus: normalize(spec.healthStatus || HEALTH.UNKNOWN),
    counters: { ...(spec.counters || {}) },
    gauges: { ...(spec.gauges || {}) },
    timers: spec.timers ? JSON.parse(JSON.stringify(spec.timers)) : {},
    traceContext: spec.traceContext ? { ...spec.traceContext } : null,
    metadata: { ...(spec.metadata || {}) },
    timestamp: spec.timestamp != null ? spec.timestamp : now,
    version: spec.version || 1,

    metrics() {
      return { counters: { ...this.counters }, gauges: { ...this.gauges }, timers: this.timers };
    },
    /**
     * Merge a report: counters ADD, gauges SET, timers accumulate {count,totalMs,
     * lastMs}, health/trace/metadata replace-or-merge. Deterministic; bumps version
     * + timestamp + checksum.
     */
    report(r = {}, nowMs) {
      if (r.counters) {
        for (const [k, v] of Object.entries(r.counters)) {
          this.counters[k] = (this.counters[k] || 0) + Number(v || 0);
        }
      }
      if (r.gauges) {
        for (const [k, v] of Object.entries(r.gauges)) this.gauges[k] = Number(v);
      }
      if (r.timers) {
        for (const [k, ms] of Object.entries(r.timers)) {
          const t = this.timers[k] || { count: 0, totalMs: 0, lastMs: 0 };
          t.count += 1;
          t.totalMs += Number(ms || 0);
          t.lastMs = Number(ms || 0);
          this.timers[k] = t;
        }
      }
      if (r.health != null) this.healthStatus = normalize(r.health);
      if (r.traceContext) this.traceContext = { ...r.traceContext };
      if (r.metadata) this.metadata = { ...this.metadata, ...r.metadata };
      this.timestamp = typeof nowMs === 'number' ? nowMs : clock();
      this.version += 1;
      this.checksum = computeChecksum(this);
      return this;
    },
    computeChecksum() {
      return computeChecksum(this);
    },
    verifyChecksum() {
      return this.checksum === computeChecksum(this);
    },
    toModel() {
      return {
        componentId: this.componentId,
        namespace: this.namespace,
        service: this.service,
        healthStatus: this.healthStatus,
        counters: { ...this.counters },
        gauges: { ...this.gauges },
        timers: JSON.parse(JSON.stringify(this.timers)),
        traceContext: this.traceContext ? { ...this.traceContext } : null,
        metadata: { ...this.metadata },
        timestamp: this.timestamp,
        version: this.version,
        checksum: this.checksum,
      };
    },
    toPublic() {
      return this.toModel();
    },
  };
  c.checksum = spec.checksum || computeChecksum(c);
  return c;
}

function fromModel(model, opts = {}) {
  const c = createComponent(model, opts);
  c.timestamp = model.timestamp;
  c.version = model.version;
  c.checksum = model.checksum != null ? model.checksum : computeChecksum(c);
  return c;
}

module.exports = { createComponent, fromModel, computeChecksum, stableStringify };
