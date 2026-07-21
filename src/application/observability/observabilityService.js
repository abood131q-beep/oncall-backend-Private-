'use strict';

/**
 * Observability Service (Phase 15.4 / ADR-033) — the Observability Kernel. Platform-
 * wide, deterministic health reporting, diagnostics, metric aggregation, tracing
 * abstractions, and runtime visibility across all Kernel Services. This is NOT
 * Prometheus/OpenTelemetry/Grafana/Datadog and NOT a logging framework — those are
 * export-provider extension points.
 *
 * Components register + report telemetry; ALL behavior lives here + in the pure
 * domain: deterministic metric aggregation, health aggregation, runtime diagnostics
 * (with redaction), component/snapshot verification, snapshot generation, trace
 * context propagation, failure aggregation, and historical snapshots. Providers
 * only store/export. Events flow ONLY through the EventPublisher port. Deterministic:
 * injected clock. Per-component reports are atomic via a serialization mutex.
 */

const {
  createComponent,
  fromModel,
  stableStringify,
} = require('../../domain/observability/component');
const {
  aggregateMetrics,
  aggregateHealthState,
} = require('../../domain/observability/aggregation');
const { redact } = require('../../domain/observability/redaction');
const { HEALTH } = require('../../domain/observability/health');
const {
  OBSERVABILITY_EVENTS,
  createObservabilityEvent,
} = require('../../domain/observability/events');
const { ObservabilityValidationError } = require('../../domain/observability/errors');
const { checksum } = require('../../domain/extensions/integrity');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createObservabilityService(deps = {}) {
  const provider = assertProvider(deps.provider);
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const clock = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  const idOpts = { idFactory: deps.idFactory };

  const _components = new Map(); // namespace -> Map(componentId -> model)
  function _bucket(ns) {
    if (!_components.has(ns)) _components.set(ns, new Map());
    return _components.get(ns);
  }
  function _all() {
    const out = [];
    for (const b of _components.values()) for (const m of b.values()) out.push(m);
    return out;
  }
  function _countHealth(status) {
    let n = 0;
    for (const m of _all()) if (m.healthStatus === status) n += 1;
    return n;
  }
  if (metrics && metrics.bindGauges) {
    metrics.bindGauges({
      registered: () => _all().length,
      healthy: () => _countHealth(HEALTH.HEALTHY),
      degraded: () => _countHealth(HEALTH.DEGRADED),
      failed: () => _countHealth(HEALTH.FAILED),
    });
  }

  const historyLimit = deps.historyLimit || 200;
  const _snapshotHistory = [];
  const _lifecycle = [];
  function _recordLifecycle(type, ns, id) {
    _lifecycle.push({ type, namespace: ns, id, at: clock() });
    if (_lifecycle.length > 500) _lifecycle.shift();
  }
  function _deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const k of Object.keys(o)) _deepFreeze(o[k]);
      Object.freeze(o);
    }
    return o;
  }

  const _locks = new Map();
  function _withLock(key, fn) {
    const prev = _locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  function _emit(type, payload) {
    try {
      const event = createObservabilityEvent(type, payload, { clock: () => new Date(clock()) });
      Promise.resolve(publisher.publish(event)).catch((e) => {
        if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
        log.error('observability: event publish failed', e.message);
      });
    } catch (e) {
      if (metrics && metrics.recordEventFailure) metrics.recordEventFailure();
      log.error('observability: could not build event', e.message);
    }
  }

  async function _safe(fn) {
    try {
      return await fn();
    } catch (e) {
      if (metrics && metrics.recordProviderFailure) metrics.recordProviderFailure();
      throw e;
    }
  }

  function _snapshotChecksum(snap) {
    return checksum(
      stableStringify({
        namespace: snap.namespace,
        generatedAt: snap.generatedAt,
        status: snap.status,
        breakdown: snap.breakdown,
        metrics: snap.metrics,
        componentIds: snap.components.map((c) => c.componentId).sort(),
      })
    );
  }

  // ── §1 register ────────────────────────────────────────────────────────────────
  function register(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    return (async () => {
      const component = createComponent(
        { ...spec, namespace },
        { clock, idFactory: idOpts.idFactory }
      );
      _bucket(namespace).set(component.componentId, component.toModel());
      _recordLifecycle('registered', namespace, component.componentId);
      if (spec.health != null) {
        _emit(OBSERVABILITY_EVENTS.HEALTH_CHANGED, {
          componentId: component.componentId,
          namespace,
          status: component.healthStatus,
        });
      }
      return component.toPublic();
    })();
  }

  // ── §1 collect (ingest a component report; upserts) ────────────────────────────
  function collect(spec = {}, opts = {}) {
    const namespace = opts.namespace || spec.namespace || 'default';
    const componentId = spec.componentId;
    if (!componentId) throw new ObservabilityValidationError('observability: componentId required');
    return _withLock(`${namespace}::${componentId}`, async () => {
      const start = clock();
      const bucket = _bucket(namespace);
      const existing = bucket.get(componentId);
      let component;
      let prevHealth = null;
      if (existing) {
        component = fromModel(existing, { clock });
        prevHealth = component.healthStatus;
      } else {
        component = createComponent(
          { componentId, service: spec.service || componentId, namespace },
          { clock, idFactory: idOpts.idFactory }
        );
      }
      component.report(
        {
          health: spec.health,
          counters: spec.counters,
          gauges: spec.gauges,
          timers: spec.timers,
          traceContext: spec.traceContext,
          metadata: spec.metadata,
        },
        clock()
      );
      bucket.set(componentId, component.toModel());
      await _safe(() =>
        provider.exportMetrics(namespace, {
          componentId,
          service: component.service,
          metrics: component.metrics(),
          healthStatus: component.healthStatus,
          at: component.timestamp,
        })
      );
      if (metrics) {
        metrics.recordCollected();
        metrics.recordLatency(clock() - start);
      }
      _emit(OBSERVABILITY_EVENTS.METRICS_COLLECTED, {
        componentId,
        namespace,
        service: component.service,
      });
      if (prevHealth !== component.healthStatus) {
        if (metrics) metrics.recordHealthChange();
        _emit(OBSERVABILITY_EVENTS.HEALTH_CHANGED, {
          componentId,
          namespace,
          status: component.healthStatus,
          previous: prevHealth,
        });
      }
      return component.toPublic();
    });
  }

  // ── §1 snapshot (deterministic aggregate) ──────────────────────────────────────
  function snapshot(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const components = [...(_components.get(namespace) || new Map()).values()];
      const metricsAgg = aggregateMetrics(components);
      const healthAgg = aggregateHealthState(components);
      const generatedAt = clock();
      const snap = {
        snapshotId: `snp_${generatedAt.toString(36)}_${namespace}`,
        namespace,
        generatedAt,
        status: healthAgg.status,
        breakdown: healthAgg.breakdown,
        metrics: metricsAgg,
        components: components.map((c) => ({ ...c })),
      };
      snap.checksum = _snapshotChecksum(snap);
      await _safe(() => provider.putSnapshot(namespace, snap));
      _snapshotHistory.push({
        snapshotId: snap.snapshotId,
        namespace,
        generatedAt,
        status: snap.status,
      });
      if (_snapshotHistory.length > historyLimit) _snapshotHistory.shift();
      if (metrics) metrics.recordSnapshot();
      _recordLifecycle('snapshot', namespace, snap.snapshotId);
      _emit(OBSERVABILITY_EVENTS.SNAPSHOT_CREATED, {
        snapshotId: snap.snapshotId,
        namespace,
        status: snap.status,
        componentCount: metricsAgg.componentCount,
      });
      return snap;
    })();
  }

  // ── §1 diagnostics (runtime, redacted) ──────────────────────────────────────────
  function diagnostics(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      let components = [...(_components.get(namespace) || new Map()).values()];
      if (opts.componentId)
        components = components.filter((c) => c.componentId === opts.componentId);
      const healthAgg = aggregateHealthState(components);
      const failures = components
        .filter((c) => c.healthStatus === HEALTH.FAILED || c.healthStatus === HEALTH.DEGRADED)
        .map((c) => ({ componentId: c.componentId, service: c.service, status: c.healthStatus }));
      const view = components.map((c) => ({
        componentId: c.componentId,
        service: c.service,
        healthStatus: c.healthStatus,
        metrics: { counters: c.counters, gauges: c.gauges, timers: c.timers },
        traceContext: c.traceContext,
        metadata: redact(c.metadata), // §9 diagnostic redaction
        timestamp: c.timestamp,
      }));
      if (metrics) metrics.recordDiagnostics();
      _recordLifecycle('diagnostics', namespace, opts.componentId || '*');
      _emit(OBSERVABILITY_EVENTS.DIAGNOSTICS_GENERATED, {
        namespace,
        componentId: opts.componentId || null,
        status: healthAgg.status,
      });
      return {
        namespace,
        generatedAt: clock(),
        health: healthAgg.status,
        breakdown: healthAgg.breakdown,
        failures,
        components: view,
        engine: {
          namespaces: _components.size,
          totalComponents: _all().length,
          snapshots: _snapshotHistory.length,
          metrics: metrics ? metrics.snapshot() : null,
        },
      };
    })();
  }

  // ── §1/§9 verify (component + snapshot integrity) ─────────────────────────────────
  function verify(opts = {}) {
    const namespace = opts.namespace || 'default';
    return (async () => {
      const issues = [];
      for (const model of (_components.get(namespace) || new Map()).values()) {
        if (!fromModel(model, { clock }).verifyChecksum()) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ componentId: model.componentId, reason: 'checksum mismatch' });
        }
      }
      const snaps = await _safe(() => provider.listSnapshots(namespace));
      for (const snap of snaps) {
        const stored = snap.checksum;
        const recomputed = _snapshotChecksum(snap);
        if (stored !== recomputed) {
          if (metrics && metrics.recordIntegrityFailure) metrics.recordIntegrityFailure();
          issues.push({ snapshotId: snap.snapshotId, reason: 'snapshot checksum mismatch' });
        }
      }
      if (metrics) metrics.recordVerification();
      const result = { ok: issues.length === 0, issues };
      _emit(OBSERVABILITY_EVENTS.VERIFICATION_COMPLETED, {
        namespace,
        ok: result.ok,
        issueCount: issues.length,
      });
      return result;
    })();
  }

  async function health() {
    const providerHealth = await provider.health();
    const components = _all();
    const healthAgg = aggregateHealthState(components);
    return {
      ok: healthAgg.status !== HEALTH.FAILED && Boolean(providerHealth && providerHealth.ok),
      status: healthAgg.status,
      breakdown: healthAgg.breakdown,
      components: components.length,
      provider: providerHealth,
      metrics: metrics ? metrics.snapshot() : null,
    };
  }

  // ── additive helpers ──────────────────────────────────────────────────────────────
  /** Trace context propagation: derive a child context from a parent. */
  function propagateTrace(parent = {}, opts2 = {}) {
    const idFactory = opts2.idFactory || idOpts.idFactory || (() => `span_${clock().toString(36)}`);
    return {
      traceId: parent.traceId || idFactory(),
      parentSpanId: parent.spanId || null,
      spanId: idFactory(),
    };
  }
  function list(opts = {}) {
    const namespace = opts.namespace || 'default';
    return [...(_components.get(namespace) || new Map()).values()].map((m) => ({ ...m }));
  }
  async function snapshotAt(namespace, snapshotId) {
    const s = await _safe(() => provider.getSnapshot(namespace, snapshotId));
    return s ? _deepFreeze(s) : null;
  }
  const history = () => _snapshotHistory.map((h) => ({ ...h }));
  const lifecycle = () => _lifecycle.map((h) => ({ ...h }));

  return {
    register,
    collect,
    snapshot,
    diagnostics,
    verify,
    health,
    // additive helpers
    propagateTrace,
    list,
    snapshotAt,
    history,
    lifecycle,
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createObservabilityService };
