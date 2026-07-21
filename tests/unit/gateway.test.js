'use strict';

/**
 * Enterprise API Gateway Kernel tests (Phase 15.6 / ADR-035) — covers every required
 * category: unit (route value object, checksum, matching primitives), routing,
 * dispatch, middleware, policy integration (injected kernel ports), provider (+ future
 * extension points), concurrency, stress, failure injection, and performance, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation + capability
 * gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRoute, fromModel, computeChecksum } = require('../../src/domain/gateway/route');
const {
  matchPath,
  matchVersion,
  resolveRoutes,
  specificity,
} = require('../../src/domain/gateway/matching');
const { createGatewayPlatform, providers } = require('../../src/application/gateway');
const { createGatewayMetrics } = require('../../src/application/gateway/metrics');
const { createRouteCache } = require('../../src/application/gateway/cache');
const { toGatewayPort } = require('../../src/application/gateway/sdkAdapter');
const {
  GatewayValidationError,
  RouteNotFoundError,
  GatewayRejectedError,
} = require('../../src/domain/gateway/errors');

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
  const gk = createGatewayPlatform({ clock, publisher: pub, ...extra });
  return { gk, G: gk.gateway, pub };
}

// ── domain: route value object + checksum ─────────────────────────────────────────

test('route: create, validation, checksum round-trip', () => {
  const clock = makeClock(1000);
  const r = createRoute({ method: 'get', path: '/trips/:id', targetService: 'trips' }, { clock });
  assert.equal(r.method, 'GET'); // normalized
  assert.ok(r.checksum && r.checksum.length === 64);
  assert.ok(r.verifyChecksum());
  const re = fromModel(r.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createRoute({ path: '/x', targetService: 't' }), GatewayValidationError); // no method
  assert.throws(() => createRoute({ method: 'GET', targetService: 't' }), GatewayValidationError); // no path
  assert.throws(
    () => createRoute({ method: 'GET', path: 'x', targetService: 't' }),
    GatewayValidationError
  ); // bad path
  assert.throws(() => createRoute({ method: 'GET', path: '/x' }), GatewayValidationError); // no target
});

// ── domain: matching primitives ───────────────────────────────────────────────────

test('matching: path params, version, specificity', () => {
  assert.deepEqual(matchPath('/trips/:id', '/trips/42'), { matched: true, params: { id: '42' } });
  assert.equal(matchPath('/trips/:id', '/trips/42/x').matched, false);
  assert.equal(matchPath('/a/*/c', '/a/b/c').matched, true); // wildcard segment
  assert.equal(matchVersion('*', '5'), true);
  assert.equal(matchVersion('1.4.0', '>=1.2.0'), true);
  assert.equal(matchVersion('1.4.0', '>=2.0.0'), false);
  assert.equal(matchVersion('v1', null), true);
  assert.ok(specificity({ path: '/a/b/c' }) > specificity({ path: '/a/:x/c' }));
});

test('matching: resolveRoutes orders by priority then specificity', () => {
  const clock = makeClock();
  const generic = createRoute(
    { routeId: 'g', method: 'GET', path: '/t/:id', targetService: 't', priority: 0 },
    { clock }
  ).toModel();
  const specific = createRoute(
    { routeId: 's', method: 'GET', path: '/t/special', targetService: 't', priority: 0 },
    { clock }
  ).toModel();
  const matches = resolveRoutes([generic, specific], { method: 'GET', path: '/t/special' });
  assert.equal(matches[0].route.routeId, 's'); // more specific wins on equal priority
  assert.equal(matches.length, 2);
});

// ── unit: metrics + cache ─────────────────────────────────────────────────────────

test('metrics: routes gauge + counters + prometheus', () => {
  const m = createGatewayMetrics({ clock: () => 0 });
  m.bindGauges({ routes: () => 4 });
  m.recordDispatch();
  m.recordResolvedOk();
  m.recordPolicyRejection();
  const s = m.snapshot();
  assert.equal(s.registeredRoutes, 4);
  assert.equal(s.dispatches, 1);
  assert.equal(s.policyRejections, 1);
  assert.match(m.prometheus(), /gateway_registered_routes 4/);
  assert.match(m.prometheus(), /gateway_policy_rejections_total 1/);
});

test('cache: per-namespace hit/miss + invalidation', () => {
  const c = createRouteCache({ maxNamespaces: 2 });
  assert.equal(c.get('a'), undefined);
  c.set('a', [{ x: 1 }]);
  assert.deepEqual(c.get('a'), [{ x: 1 }]);
  c.invalidate('a');
  assert.equal(c.get('a'), undefined);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores routes; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putRoute('n', { routeId: 'r1', method: 'GET', path: '/x' });
  assert.equal((await mem.getRoute('n', 'r1')).path, '/x');
  assert.equal((await mem.listRoutes('n')).length, 1);
  assert.equal(await mem.removeRoute('n', 'r1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('kong'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('envoy'));
  const p = providers.futureProvider('nginx');
  assert.equal(p.planned, true);
  assert.throws(() => p.putRoute('n', {}), /extension point/);
});

// ── routing + resolve + events ──────────────────────────────────────────────────────

test('gateway: register + resolve; version-aware; events', async () => {
  const clock = makeClock(1000);
  const { G, pub } = platform(clock);
  await G.registerRoute({
    method: 'GET',
    path: '/trips/:id',
    targetService: 'trips',
    version: '>=1.0.0',
  });
  const r = await G.resolve({ method: 'GET', path: '/trips/42', version: '1.5.0' });
  assert.equal(r.params.id, '42');
  assert.equal(r.route.targetService, 'trips');
  await assert.rejects(() => G.resolve({ method: 'GET', path: '/nope' }), RouteNotFoundError);
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('RouteRegistered') && types.includes('RouteResolved'));
  assert.ok(pub.events.every((e) => e.producer === 'gateway'));
});

// ── dispatch + middleware ──────────────────────────────────────────────────────────

test('gateway: dispatch runs the middleware pipeline in order + handler', async () => {
  const clock = makeClock(1000);
  const { G, pub } = platform(clock);
  const seen = [];
  G.registerMiddleware('mw1', async (ctx) => {
    ctx.request.headers.a = '1';
    seen.push('mw1');
  });
  G.registerMiddleware('mw2', async () => seen.push('mw2'));
  await G.registerRoute({
    method: 'POST',
    path: '/orders',
    targetEndpoint: 'http://orders:8080',
    middlewareChain: ['mw1', 'mw2'],
    handler: async (ctx) => ({ ok: true, a: ctx.request.headers.a }),
  });
  const d = await G.dispatch({ method: 'POST', path: '/orders', body: {} });
  assert.equal(d.status, 'dispatched');
  assert.deepEqual(d.middlewareTrace, ['mw1', 'mw2']);
  assert.deepEqual(d.result, { ok: true, a: '1' });
  assert.equal(d.target.endpoint, 'http://orders:8080');
  assert.ok(pub.events.some((e) => e.type === 'RequestDispatched'));
});

test('gateway: a middleware that throws GatewayRejectedError rejects the request', async () => {
  const clock = makeClock();
  const { G } = platform(clock);
  const { GatewayRejectedError: RErr } = require('../../src/domain/gateway/errors');
  G.registerMiddleware('deny', async () => {
    throw new RErr('blocked', 'middleware_denied');
  });
  await G.registerRoute({
    method: 'GET',
    path: '/x',
    targetEndpoint: 'http://x:1',
    middlewareChain: ['deny'],
  });
  await assert.rejects(() => G.dispatch({ method: 'GET', path: '/x' }), GatewayRejectedError);
  await G.registerRoute({
    method: 'GET',
    path: '/y',
    targetEndpoint: 'http://y:1',
    middlewareChain: ['ghost'],
  });
  await assert.rejects(() => G.dispatch({ method: 'GET', path: '/y' }), /middleware_missing/);
});

// ── policy integration (injected kernel ports) ──────────────────────────────────────

test('gateway: identity + policy + rate-limit + discovery ports enforce on dispatch', async () => {
  const clock = makeClock(1000);
  const calls = [];
  const ports = {
    identity: {
      resolve: async () => {
        calls.push('id');
        return { ok: true, context: { authenticated: true, principal: 'u1' } };
      },
    },
    policy: {
      evaluate: async () => {
        calls.push('policy');
        return { effect: 'allow' };
      },
    },
    ratelimit: {
      consume: async () => {
        calls.push('rl');
        return { allowed: true };
      },
    },
    discovery: {
      resolve: async () => {
        calls.push('disc');
        return { selected: { endpoint: 'http://resolved:9' } };
      },
    },
  };
  const { G } = platform(clock, { ports });
  await G.registerRoute({
    method: 'GET',
    path: '/secure',
    targetService: 'trips',
    authRequired: true,
    policies: ['p1'],
    rateLimitPolicy: 'rl1',
  });
  const d = await G.dispatch({ method: 'GET', path: '/secure', token: 'tok', subject: 'u1' });
  assert.equal(d.identity, 'u1'); // identity context propagated
  assert.equal(d.target.endpoint, 'http://resolved:9'); // discovery-resolved endpoint
  assert.deepEqual(calls, ['id', 'policy', 'rl', 'disc']);
});

test('gateway: unauthenticated + policy-deny + rate-limited are rejected', async () => {
  const clock = makeClock();
  // deny identity
  const denyId = { identity: { resolve: async () => ({ ok: false }) } };
  let g = platform(clock, { ports: denyId });
  await g.G.registerRoute({
    method: 'GET',
    path: '/a',
    targetEndpoint: 'http://a:1',
    authRequired: true,
  });
  await assert.rejects(() => g.G.dispatch({ method: 'GET', path: '/a' }), /unauthenticated/);

  // policy deny
  const denyPolicy = { policy: { evaluate: async () => ({ effect: 'deny' }) } };
  g = platform(clock, { ports: denyPolicy });
  await g.G.registerRoute({
    method: 'GET',
    path: '/b',
    targetEndpoint: 'http://b:1',
    policies: ['p'],
  });
  await assert.rejects(() => g.G.dispatch({ method: 'GET', path: '/b' }), /policy_denied/);

  // rate limited
  const rl = { ratelimit: { consume: async () => ({ allowed: false }) } };
  g = platform(clock, { ports: rl });
  await g.G.registerRoute({
    method: 'GET',
    path: '/c',
    targetEndpoint: 'http://c:1',
    rateLimitPolicy: 'r',
  });
  await assert.rejects(() => g.G.dispatch({ method: 'GET', path: '/c' }), /rate_limited/);
  assert.ok(g.gk.gateway.metrics().policyRejections >= 1);
});

test('gateway: feature flag gating rejects when the flag is off', async () => {
  const clock = makeClock();
  const ports = { features: { evaluate: async () => ({ served: false, value: false }) } };
  const { G } = platform(clock, { ports });
  await G.registerRoute({
    method: 'GET',
    path: '/beta',
    targetEndpoint: 'http://b:1',
    metadata: { featureFlag: 'beta' },
  });
  await assert.rejects(() => G.dispatch({ method: 'GET', path: '/beta' }), /feature_disabled/);
});

// ── timeout ─────────────────────────────────────────────────────────────────────────

test('gateway: dispatch exceeding the route timeout is rejected', async () => {
  const clock = makeClock(1000);
  const { G } = platform(clock);
  G.registerMiddleware('slow', async () => {
    clock.set(clock() + 5000);
  });
  await G.registerRoute({
    method: 'GET',
    path: '/slow',
    targetEndpoint: 'http://s:1',
    middlewareChain: ['slow'],
    timeout: 1000,
  });
  await assert.rejects(() => G.dispatch({ method: 'GET', path: '/slow' }), /timeout/);
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('gateway: verify detects tampered route + unregistered middleware', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { G } = platform(clock, { provider });
  const r = await G.registerRoute({ method: 'GET', path: '/x', targetEndpoint: 'http://x:1' });
  assert.equal((await G.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getRoute('default', r.routeId);
  await provider.putRoute('default', { ...stored, targetEndpoint: 'http://evil:1' }); // stale checksum
  const v = await G.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.routeId === r.routeId));
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no route registration', async () => {
  const clock = makeClock();
  const { G } = platform(clock);
  await G.registerRoute(
    { method: 'GET', path: '/x', targetEndpoint: 'http://alice:1' },
    { namespace: 'ext.alice' }
  );
  await G.registerRoute(
    { method: 'GET', path: '/x', targetEndpoint: 'http://bob:1' },
    { namespace: 'ext.bob' }
  );
  const alice = toGatewayPort(G, { owner: 'alice' });
  const bob = toGatewayPort(G, { owner: 'bob' });
  assert.equal(
    (await alice.resolve({ method: 'GET', path: '/x' })).route.targetEndpoint,
    'http://alice:1'
  );
  assert.equal(
    (await bob.resolve({ method: 'GET', path: '/x' })).route.targetEndpoint,
    'http://bob:1'
  );
  assert.equal((await alice.listRoutes()).length, 1); // only own namespace
  assert.equal(typeof alice.registerRoute, 'undefined'); // no route registration
  assert.equal(typeof alice.registerMiddleware, 'undefined'); // no middleware registration
  const noDispatch = toGatewayPort(G, { owner: 'x', canDispatch: false });
  await assert.rejects(
    async () => noDispatch.dispatch({ method: 'GET', path: '/x' }),
    /gateway:dispatch/
  );
  const noRead = toGatewayPort(G, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.resolve({ method: 'GET', path: '/x' }), /gateway:read/);
  assert.throws(() => toGatewayPort(G, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('gateway: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putRoute: () => Promise.reject(new Error('store down')),
    getRoute: () => Promise.resolve(null),
    listRoutes: () => Promise.resolve([]),
    removeRoute: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { G, gk } = platform(clock, { provider: failing });
  await assert.rejects(
    () => G.registerRoute({ method: 'GET', path: '/x', targetEndpoint: 'http://x:1' }),
    /store down/
  );
  assert.ok(gk.gateway.metrics().providerFailures >= 1);
  assert.equal((await G.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('gateway: concurrent dispatches to distinct routes all resolve', async () => {
  const clock = makeClock(1000);
  const { G } = platform(clock);
  for (let i = 0; i < 20; i++) {
    await G.registerRoute({ method: 'GET', path: '/r' + i, targetEndpoint: 'http://h' + i + ':1' });
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => G.dispatch({ method: 'GET', path: '/r' + i }))
  );
  assert.ok(results.every((r) => r.status === 'dispatched'));
  assert.equal(new Set(results.map((r) => r.routeId)).size, 20);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('gateway: stress — 1000 routes dispatch fast + consistent', async () => {
  const clock = makeClock(1000);
  const { G, gk } = platform(clock);
  for (let i = 0; i < 1000; i++) {
    await G.registerRoute({
      method: 'GET',
      path: '/svc/' + i + '/:id',
      targetEndpoint: 'http://h' + i + ':1',
    });
  }
  const start = Date.now();
  let ok = 0;
  for (let i = 0; i < 1000; i++) {
    const d = await G.dispatch({ method: 'GET', path: '/svc/' + i + '/42' });
    if (d.status === 'dispatched' && d.params.id === '42') ok += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(ok, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal((await G.verify({ namespace: 'default' })).ok, true);
  assert.equal(gk.gateway.metrics().registeredRoutes, 1000);
});

test('route checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { G, gk } = platform(clock);
  const r = await G.registerRoute({
    method: 'GET',
    path: '/x',
    targetService: 'trips',
    policies: ['p'],
  });
  const model = await gk.provider.getRoute('default', r.routeId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
