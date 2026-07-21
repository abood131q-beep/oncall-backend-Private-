'use strict';

/**
 * Enterprise Service Mesh Kernel tests (Phase 15.8 / ADR-037) — covers every required
 * category: unit (connection value object, checksum, policy evaluation), connection
 * lifecycle, invocation, policy, routing, provider (+ future extension points),
 * concurrency, stress, failure injection, and performance, plus events-via-port and
 * the SDK owner-scoped adapter (namespace isolation + capability gates). Deterministic:
 * clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConnection,
  fromModel,
  computeChecksum,
  STATE,
} = require('../../src/domain/mesh/connection');
const { evaluatePolicies, evaluateSecurity } = require('../../src/domain/mesh/policies');
const { createMeshPlatform, providers } = require('../../src/application/mesh');
const { createMeshMetrics } = require('../../src/application/mesh/metrics');
const { toMeshPort } = require('../../src/application/mesh/sdkAdapter');
const {
  MeshValidationError,
  ConnectionNotFoundError,
  MeshRejectedError,
} = require('../../src/domain/mesh/errors');

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
  const mk = createMeshPlatform({ clock, publisher: pub, ...extra });
  return { mk, M: mk.mesh, pub };
}

// ── domain: connection value object + checksum ────────────────────────────────────

test('connection: create, validation, checksum (excludes state), transitions', () => {
  const clock = makeClock(1000);
  const c = createConnection(
    { sourceService: 'gw', destinationService: 'trips', protocol: 'grpc' },
    { clock }
  );
  assert.equal(c.connectionState, STATE.REGISTERED);
  assert.ok(c.verifyChecksum());
  const before = c.checksum;
  c.establish(1100); // state is NOT part of the checksum
  assert.equal(c.connectionState, STATE.ESTABLISHED);
  assert.equal(c.checksum, before);
  const re = fromModel(c.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createConnection({ destinationService: 'x' }), MeshValidationError); // no source
  assert.throws(() => createConnection({ sourceService: 'x' }), MeshValidationError); // no dest
});

// ── domain: policy evaluation ───────────────────────────────────────────────────────

test('policies: mutual identity + allowed sources + routing', () => {
  const clock = makeClock();
  const c = createConnection(
    {
      sourceService: 'gw',
      destinationService: 'trips',
      securityPolicy: { requireIdentity: true, allowedSources: ['gw'] },
      routingPolicy: { strategy: 'subset', subset: 'v2' },
    },
    { clock }
  );
  assert.equal(evaluateSecurity(c, { identity: null }).reason, 'identity_required');
  assert.equal(
    evaluateSecurity(c, { identity: { p: 1 }, sourceService: 'evil' }).reason,
    'source_not_allowed'
  );
  const ok = evaluatePolicies(c, { identity: { principal: 'u1' }, sourceService: 'gw' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.route.subset, 'v2');
  assert.equal(ok.route.destination, 'trips');
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createMeshMetrics({ clock: () => 0 });
  m.bindGauges({ registered: () => 3, active: () => 2 });
  m.recordInvocation();
  m.recordSuccess();
  m.recordPolicyViolation();
  const s = m.snapshot();
  assert.equal(s.registeredConnections, 3);
  assert.equal(s.activeConnections, 2);
  assert.equal(s.policyViolations, 1);
  assert.match(m.prometheus(), /mesh_active_connections 2/);
  assert.match(m.prometheus(), /mesh_policy_violations_total 1/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores connections; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putConnection('n', { connectionId: 'c1', sourceService: 'a', destinationService: 'b' });
  assert.equal((await mem.getConnection('n', 'c1')).destinationService, 'b');
  assert.equal((await mem.listConnections('n')).length, 1);
  assert.equal(await mem.removeConnection('n', 'c1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('istio'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('linkerd'));
  const p = providers.futureProvider('consul-connect');
  assert.equal(p.planned, true);
  assert.throws(() => p.putConnection('n', {}), /extension point/);
});

// ── connection lifecycle + events ────────────────────────────────────────────────────

test('mesh: registerPolicy + connect + disconnect lifecycle; events', async () => {
  const clock = makeClock(1000);
  const { M, pub } = platform(clock);
  const c = await M.registerPolicy({ sourceService: 'gw', destinationService: 'trips' });
  assert.equal(c.connectionState, STATE.REGISTERED);
  const est = await M.connect({ connectionId: c.connectionId });
  assert.equal(est.connectionState, STATE.ESTABLISHED);
  assert.equal(await M.disconnect({ connectionId: c.connectionId }), true);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('ConnectionRegistered') &&
      types.includes('ConnectionEstablished') &&
      types.includes('ConnectionClosed')
  );
  assert.ok(pub.events.every((e) => e.producer === 'mesh'));
  await assert.rejects(() => M.connect({ connectionId: 'ghost' }), ConnectionNotFoundError);
});

// ── invocation ──────────────────────────────────────────────────────────────────────

test('mesh: invoke runs the call over an established connection with secure context', async () => {
  const clock = makeClock(1000);
  const { M, pub } = platform(clock);
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    routingPolicy: { subset: 'v1' },
  });
  await M.connect({ connectionId: c.connectionId });
  let seenCtx = null;
  const r = await M.invoke({
    connectionId: c.connectionId,
    fn: async (ctx) => {
      seenCtx = ctx;
      return 'result';
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.result, 'result');
  assert.equal(seenCtx.destination, 'trips'); // secure context propagated
  assert.equal(seenCtx.route.subset, 'v1');
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('InvocationStarted') && types.includes('InvocationCompleted'));
  // cannot invoke a non-established connection
  const c2 = await M.registerPolicy({ sourceService: 'gw', destinationService: 'billing' });
  await assert.rejects(
    () => M.invoke({ connectionId: c2.connectionId, fn: async () => 1 }),
    MeshRejectedError
  );
  await assert.rejects(() => M.invoke({ connectionId: c.connectionId }), MeshValidationError); // no fn
});

// ── policy (mutual identity via injected Identity port) ──────────────────────────────

test('mesh: security policy enforces mutual identity + allowed sources', async () => {
  const clock = makeClock();
  const ports = {
    identity: {
      resolve: async () => ({ ok: true, context: { authenticated: true, principal: 'u1' } }),
    },
  };
  const { M, mk } = platform(clock, { ports });
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    securityPolicy: { requireIdentity: true, allowedSources: ['gw'] },
  });
  await M.connect({ connectionId: c.connectionId });
  // authenticated source 'gw' → allowed
  const r = await M.invoke({ connectionId: c.connectionId, token: 'tok', fn: async () => 'ok' });
  assert.equal(r.result, 'ok');
  // disallowed source → policy violation
  await assert.rejects(
    () =>
      M.invoke({
        connectionId: c.connectionId,
        token: 'tok',
        sourceService: 'evil',
        fn: async () => 1,
      }),
    /source_not_allowed/
  );
  // missing identity → identity_required
  const c2 = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 't2',
    securityPolicy: { requireIdentity: true },
  });
  await M.connect({ connectionId: c2.connectionId });
  await assert.rejects(
    () => M.invoke({ connectionId: c2.connectionId, fn: async () => 1 }),
    /identity_required/
  );
  assert.ok(mk.mesh.metrics().policyViolations >= 2);
});

// ── routing (injected discovery port resolves the endpoint) ──────────────────────────

test('mesh: destination endpoint resolved via Service Discovery port', async () => {
  const clock = makeClock();
  const ports = {
    discovery: { resolve: async () => ({ selected: { endpoint: 'http://trips-7:9' } }) },
  };
  const { M } = platform(clock, { ports });
  const c = await M.registerPolicy({ sourceService: 'gw', destinationService: 'trips' });
  await M.connect({ connectionId: c.connectionId });
  let ep = null;
  await M.invoke({
    connectionId: c.connectionId,
    fn: async (ctx) => {
      ep = ctx.endpoint;
    },
  });
  assert.equal(ep, 'http://trips-7:9');
});

// ── retry delegation to the Resilience port ──────────────────────────────────────────

test('mesh: invocation retry delegated to the Resilience port', async () => {
  const clock = makeClock();
  const calls = [];
  const ports = {
    resilience: {
      execute: async ({ policyId, fn }) => {
        calls.push(policyId);
        return { ok: true, result: await fn() };
      },
    },
  };
  const { M } = platform(clock, { ports });
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    retryPolicy: { resiliencePolicyId: 'trips-resilience' },
  });
  await M.connect({ connectionId: c.connectionId });
  const r = await M.invoke({ connectionId: c.connectionId, fn: async () => 'via-resilience' });
  assert.equal(r.result, 'via-resilience');
  assert.deepEqual(calls, ['trips-resilience']); // delegated
});

// ── timeout + traffic limit ──────────────────────────────────────────────────────────

test('mesh: invocation exceeding timeout fails', async () => {
  const clock = makeClock(1000);
  const { M } = platform(clock);
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    timeout: 1000,
  });
  await M.connect({ connectionId: c.connectionId });
  await assert.rejects(
    () =>
      M.invoke({
        connectionId: c.connectionId,
        fn: async () => {
          clock.set(clock() + 5000);
        },
      }),
    /timeout/
  );
});

test('mesh: traffic maxConcurrent limit is enforced', async () => {
  const clock = makeClock();
  const { M, mk } = platform(clock);
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    trafficPolicy: { maxConcurrent: 1 },
  });
  await M.connect({ connectionId: c.connectionId });
  let release;
  const gate = new Promise((res) => (release = res));
  const a = M.invoke({
    connectionId: c.connectionId,
    fn: async () => {
      await gate;
      return 1;
    },
  });
  await assert.rejects(
    () => M.invoke({ connectionId: c.connectionId, fn: async () => 2 }),
    /traffic_limit/
  );
  release();
  await a;
  assert.ok(mk.mesh.metrics().policyViolations >= 1);
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('mesh: verify + invoke detect a tampered connection', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { M } = platform(clock, { provider });
  const c = await M.registerPolicy({ sourceService: 'gw', destinationService: 'trips' });
  await M.connect({ connectionId: c.connectionId });
  assert.equal((await M.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getConnection('default', c.connectionId);
  await provider.putConnection('default', { ...stored, destinationService: 'evil' }); // stale checksum
  const v = await M.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  await assert.rejects(
    () => M.invoke({ connectionId: c.connectionId, fn: async () => 1 }),
    /integrity/
  );
});

// ── SDK adapter ─────────────────────────────────────────────────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no authoring', async () => {
  const clock = makeClock();
  const { M } = platform(clock);
  const c = await M.registerPolicy(
    { sourceService: 'gw', destinationService: 't' },
    { namespace: 'ext.alice' }
  );
  await M.connect({ connectionId: c.connectionId }, { namespace: 'ext.alice' });
  const alice = toMeshPort(M, { owner: 'alice' });
  const r = await alice.invoke({ connectionId: c.connectionId, fn: async () => 'ok' });
  assert.equal(r.result, 'ok');
  assert.equal((await alice.list()).length, 1); // only own namespace
  assert.equal(typeof alice.registerPolicy, 'undefined'); // no authoring
  assert.equal(typeof alice.connect, 'undefined'); // no lifecycle
  const noInvoke = toMeshPort(M, { owner: 'x', canInvoke: false });
  await assert.rejects(
    async () => noInvoke.invoke({ connectionId: 'c', fn: async () => 1 }),
    /mesh:invoke/
  );
  const noRead = toMeshPort(M, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.list(), /mesh:read/);
  assert.throws(() => toMeshPort(M, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('mesh: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putConnection: () => Promise.reject(new Error('store down')),
    getConnection: () => Promise.resolve(null),
    listConnections: () => Promise.resolve([]),
    removeConnection: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { M, mk } = platform(clock, { provider: failing });
  await assert.rejects(
    () => M.registerPolicy({ sourceService: 'a', destinationService: 'b' }),
    /store down/
  );
  assert.ok(mk.mesh.metrics().providerFailures >= 1);
  assert.equal((await M.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('mesh: concurrent invocations across connections all succeed', async () => {
  const clock = makeClock();
  const { M } = platform(clock);
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const c = await M.registerPolicy({ sourceService: 'gw', destinationService: 'svc' + i });
    await M.connect({ connectionId: c.connectionId });
    ids.push(c.connectionId);
  }
  const results = await Promise.all(
    ids.map((id) => M.invoke({ connectionId: id, fn: async () => id }))
  );
  assert.equal(results.filter((r) => r.ok).length, 20);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('mesh: stress — 1000 invocations fast + consistent', async () => {
  const clock = makeClock();
  const { M, mk } = platform(clock);
  const c = await M.registerPolicy({ sourceService: 'gw', destinationService: 'trips' });
  await M.connect({ connectionId: c.connectionId });
  const start = Date.now();
  let ok = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await M.invoke({ connectionId: c.connectionId, subject: 'u' + i, fn: async () => i });
    if (r.ok) ok += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(ok, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal(mk.mesh.metrics().successfulInvocations, 1000);
  assert.equal((await M.verify({ namespace: 'default' })).ok, true);
});

test('connection checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { M, mk } = platform(clock);
  const c = await M.registerPolicy({
    sourceService: 'gw',
    destinationService: 'trips',
    securityPolicy: { requireIdentity: true },
  });
  const model = await mk.provider.getConnection('default', c.connectionId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
