'use strict';

/**
 * Enterprise Observability Kernel tests (Phase 15.4 / ADR-033) — covers every
 * required category: unit (component value object, health lattice, redaction),
 * aggregation, health, snapshot, diagnostics, provider (+ future extension points),
 * concurrency, stress, failure injection, and performance, plus events-via-port and
 * the SDK owner-scoped adapter (namespace isolation + capability gates).
 * Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createComponent,
  fromModel,
  computeChecksum,
} = require('../../src/domain/observability/component');
const { HEALTH, aggregate } = require('../../src/domain/observability/health');
const { aggregateMetrics } = require('../../src/domain/observability/aggregation');
const { redact, REDACTED } = require('../../src/domain/observability/redaction');
const { createObservabilityPlatform, providers } = require('../../src/application/observability');
const { createObservabilityMetrics } = require('../../src/application/observability/metrics');
const { toObservabilityPort } = require('../../src/application/observability/sdkAdapter');
const { ObservabilityValidationError } = require('../../src/domain/observability/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}
function platform(clock, extra = {}) {
  const pub = recordingPublisher();
  const ok = createObservabilityPlatform({ clock, publisher: pub, ...extra });
  return { ok, O: ok.observability, pub };
}

// ── domain: component value object + checksum ─────────────────────────────────────

test('component: create, report merge (counters add, gauges set, timers accumulate), checksum', () => {
  const clock = makeClock(1000);
  const c = createComponent({ componentId: 'a', service: 'trips' }, { clock });
  assert.equal(c.healthStatus, HEALTH.UNKNOWN);
  assert.ok(c.verifyChecksum());
  c.report(
    { counters: { req: 2 }, gauges: { open: 5 }, timers: { db: 10 }, health: 'healthy' },
    1100
  );
  c.report({ counters: { req: 3 }, gauges: { open: 7 }, timers: { db: 20 } }, 1200);
  assert.equal(c.counters.req, 5); // added
  assert.equal(c.gauges.open, 7); // set (latest)
  assert.equal(c.timers.db.count, 2);
  assert.equal(c.timers.db.totalMs, 30);
  assert.equal(c.healthStatus, HEALTH.HEALTHY);
  const re = fromModel(c.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createComponent({}), ObservabilityValidationError); // no service
});

test('health: worst-of aggregation lattice', () => {
  assert.equal(aggregate([]), HEALTH.UNKNOWN);
  assert.equal(aggregate(['healthy', 'healthy']), HEALTH.HEALTHY);
  assert.equal(aggregate(['healthy', 'degraded']), HEALTH.DEGRADED);
  assert.equal(aggregate(['healthy', 'degraded', 'failed']), HEALTH.FAILED);
  assert.equal(aggregate(['healthy', 'unknown']), HEALTH.UNKNOWN);
});

test('redaction: sensitive keys masked recursively', () => {
  const r = redact({ token: 'abc', nested: { password: 'x', ok: 1 }, list: [{ apiKey: 'k' }] });
  assert.equal(r.token, REDACTED);
  assert.equal(r.nested.password, REDACTED);
  assert.equal(r.nested.ok, 1);
  assert.equal(r.list[0].apiKey, REDACTED);
});

// ── domain: aggregation (deterministic) ───────────────────────────────────────────

test('aggregation: counters sum, gauges sum, timers merge — order-independent', () => {
  const a = {
    componentId: 'a',
    counters: { x: 1 },
    gauges: { g: 2 },
    timers: { t: { count: 1, totalMs: 10 } },
  };
  const b = {
    componentId: 'b',
    counters: { x: 4 },
    gauges: { g: 3 },
    timers: { t: { count: 2, totalMs: 30 } },
  };
  const r1 = aggregateMetrics([a, b]);
  const r2 = aggregateMetrics([b, a]); // reversed input
  assert.deepEqual(r1, r2); // deterministic regardless of order
  assert.equal(r1.counters.x, 5);
  assert.equal(r1.gauges.g, 5);
  assert.equal(r1.timers.t.count, 3);
  assert.equal(r1.timers.t.avgMs, 40 / 3);
  assert.equal(r1.componentCount, 2);
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createObservabilityMetrics({ clock: () => 0 });
  m.bindGauges({ registered: () => 3, healthy: () => 2, degraded: () => 1, failed: () => 0 });
  m.recordCollected();
  m.recordSnapshot();
  m.recordVerification();
  const s = m.snapshot();
  assert.equal(s.registeredComponents, 3);
  assert.equal(s.healthyComponents, 2);
  assert.equal(s.metricsCollected, 1);
  assert.match(m.prometheus(), /observability_registered_components 3/);
  assert.match(m.prometheus(), /observability_snapshots_total 1/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores snapshots + exports; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.exportMetrics('n', { componentId: 'a' });
  await mem.putSnapshot('n', { snapshotId: 's1', status: 'healthy' });
  assert.equal((await mem.getSnapshot('n', 's1')).status, 'healthy');
  assert.equal((await mem.listSnapshots('n')).length, 1);
  assert.equal(mem.exports('n').length, 1);
  assert.ok(providers.FUTURE_PROVIDERS.includes('prometheus'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('opentelemetry'));
  const p = providers.futureProvider('datadog');
  assert.equal(p.planned, true);
  assert.throws(() => p.putSnapshot('n', {}), /extension point/);
});

// ── register + collect + events + export ───────────────────────────────────────────

test('observability: register + collect merges telemetry; events + export', async () => {
  const clock = makeClock(1000);
  const { ok, O, pub } = platform(clock);
  await O.register({ componentId: 'trips', service: 'trips' });
  await O.collect({
    componentId: 'trips',
    health: 'healthy',
    counters: { req: 1 },
    gauges: { open: 3 },
  });
  await O.collect({ componentId: 'trips', counters: { req: 2 }, timers: { db: 15 } });
  const list = O.list();
  assert.equal(list[0].counters.req, 3);
  assert.equal(list[0].healthStatus, HEALTH.HEALTHY);
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('MetricsCollected') && types.includes('HealthChanged'));
  assert.ok(pub.events.every((e) => e.producer === 'observability'));
  assert.equal(ok.provider.exports('default').length, 2); // exported on each collect
  await assert.rejects(async () => O.collect({ health: 'healthy' }), ObservabilityValidationError); // no id
});

// ── health aggregation ────────────────────────────────────────────────────────────

test('observability: health rolls up worst-of across components', async () => {
  const clock = makeClock();
  const { O } = platform(clock);
  await O.collect({ componentId: 'a', health: 'healthy' });
  await O.collect({ componentId: 'b', health: 'degraded' });
  let h = await O.health();
  assert.equal(h.status, HEALTH.DEGRADED);
  assert.equal(h.breakdown.degraded, 1);
  await O.collect({ componentId: 'c', health: 'failed' });
  h = await O.health();
  assert.equal(h.status, HEALTH.FAILED);
  assert.equal(h.ok, false);
});

// ── snapshot ────────────────────────────────────────────────────────────────────

test('observability: snapshot aggregates + persists + is checksum-verifiable', async () => {
  const clock = makeClock(1000);
  const { ok, O, pub } = platform(clock);
  await O.collect({ componentId: 'a', health: 'healthy', counters: { req: 5 } });
  await O.collect({ componentId: 'b', health: 'healthy', counters: { req: 7 } });
  const snap = await O.snapshot();
  assert.equal(snap.status, HEALTH.HEALTHY);
  assert.equal(snap.metrics.counters.req, 12);
  assert.equal(snap.metrics.componentCount, 2);
  assert.ok(snap.checksum);
  // persisted + retrievable
  const stored = await ok.provider.getSnapshot('default', snap.snapshotId);
  assert.equal(stored.snapshotId, snap.snapshotId);
  assert.ok(pub.events.some((e) => e.type === 'SnapshotCreated'));
  assert.ok(O.history().some((h) => h.snapshotId === snap.snapshotId));
});

// ── diagnostics + redaction ─────────────────────────────────────────────────────

test('observability: diagnostics redacts sensitive metadata + aggregates failures', async () => {
  const clock = makeClock();
  const { O, pub } = platform(clock);
  await O.collect({
    componentId: 'a',
    health: 'failed',
    metadata: { apiKey: 'secret-value', region: 'us' },
  });
  await O.collect({ componentId: 'b', health: 'healthy' });
  const d = await O.diagnostics({ namespace: 'default' });
  assert.equal(d.health, HEALTH.FAILED);
  assert.equal(d.failures.length, 1);
  const a = d.components.find((c) => c.componentId === 'a');
  assert.equal(a.metadata.apiKey, REDACTED); // redacted
  assert.equal(a.metadata.region, 'us'); // non-sensitive preserved
  assert.ok(pub.events.some((e) => e.type === 'DiagnosticsGenerated'));
});

// ── verify / integrity ─────────────────────────────────────────────────────────────

test('observability: verify detects component + snapshot tampering', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { O } = platform(clock, { provider });
  await O.collect({ componentId: 'a', health: 'healthy', counters: { req: 1 } });
  const snap = await O.snapshot();
  assert.equal((await O.verify({ namespace: 'default' })).ok, true);
  // tamper a stored snapshot
  const stored = await provider.getSnapshot('default', snap.snapshotId);
  await provider.putSnapshot('default', { ...stored, status: 'failed' });
  const v = await O.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.snapshotId === snap.snapshotId));
});

// ── trace context propagation ─────────────────────────────────────────────────────

test('observability: trace context propagation derives child spans', () => {
  const clock = makeClock();
  let n = 0;
  const { O } = platform(clock, { idFactory: () => `id-${++n}` });
  const root = O.propagateTrace({});
  assert.ok(root.traceId && root.spanId);
  assert.equal(root.parentSpanId, null);
  const child = O.propagateTrace(root);
  assert.equal(child.traceId, root.traceId); // same trace
  assert.equal(child.parentSpanId, root.spanId); // linked
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates capabilities', async () => {
  const clock = makeClock();
  const { O } = platform(clock);
  const alice = toObservabilityPort(O, { owner: 'alice' });
  const bob = toObservabilityPort(O, { owner: 'bob' });
  await alice.collect({ componentId: 'a', health: 'healthy' });
  await bob.collect({ componentId: 'a', health: 'failed' }); // same id, different namespace
  const sa = await alice.snapshot();
  const sb = await bob.snapshot();
  assert.equal(sa.status, HEALTH.HEALTHY);
  assert.equal(sb.status, HEALTH.FAILED); // isolated
  const noDiag = toObservabilityPort(O, { owner: 'x', canDiagnostics: false });
  await assert.rejects(async () => noDiag.diagnostics(), /observability:diagnostics/);
  const noRead = toObservabilityPort(O, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.collect({ componentId: 'a' }), /observability:read/);
  assert.throws(() => toObservabilityPort(O, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('observability: provider failures are counted (export path)', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    exportMetrics: () => Promise.reject(new Error('export down')),
    putSnapshot: () => Promise.resolve(),
    getSnapshot: () => Promise.resolve(null),
    listSnapshots: () => Promise.resolve([]),
    health: () => ({ ok: false }),
  };
  const { O, ok } = platform(clock, { provider: failing });
  await assert.rejects(() => O.collect({ componentId: 'a', health: 'healthy' }), /export down/);
  assert.ok(ok.metrics.snapshot().providerFailures >= 1);
  assert.equal((await O.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('observability: concurrent collects on one component serialize (counters exact)', async () => {
  const clock = makeClock();
  const { O } = platform(clock);
  await Promise.all(
    Array.from({ length: 50 }, () =>
      O.collect({ componentId: 'hot', health: 'healthy', counters: { hits: 1 } })
    )
  );
  assert.equal(O.list()[0].counters.hits, 50); // no lost updates
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('observability: stress — 1000 components snapshot fast + consistent', async () => {
  const clock = makeClock();
  const { O } = platform(clock);
  for (let i = 0; i < 1000; i++) {
    await O.collect({
      componentId: 'c' + i,
      health: i % 100 === 0 ? 'degraded' : 'healthy',
      counters: { n: i },
    });
  }
  const start = Date.now();
  const snap = await O.snapshot();
  const elapsed = Date.now() - start;
  assert.equal(snap.metrics.componentCount, 1000);
  assert.equal(snap.status, HEALTH.DEGRADED); // 10 degraded present
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal((await O.verify({ namespace: 'default' })).ok, true);
});

test('snapshot checksum is stable across recompute', async () => {
  const clock = makeClock();
  const { O, ok } = platform(clock);
  await O.collect({ componentId: 'a', health: 'healthy' });
  const snap = await O.snapshot();
  const stored = await ok.provider.getSnapshot('default', snap.snapshotId);
  assert.equal(stored.checksum, snap.checksum);
  // component checksum stable via re-hydration
  const c = O.list()[0];
  assert.equal(c.checksum, computeChecksum(fromModel(c)));
});
