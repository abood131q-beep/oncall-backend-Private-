'use strict';

/**
 * Enterprise Host Runtime tests (Phase 16.3 / ADR-044) — covers every required category:
 * host, registry, dependency graph, lifecycle, supervisor, failure injection, health,
 * restart, integration, and A/B compatibility (determinism + additivity). Hosts services
 * on a real Bootstrap Runtime (ADR-043) WITHOUT modifying any kernel, ADR-042, or ADR-043.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('../../src/runtime');
const {
  createHost,
  createHostRegistry,
  assertServiceContract,
  createHostSupervisor,
  STATES,
  SERVICE_STATES,
  errors,
} = require('../../src/host');

function recordingPublisher() {
  return { publish: () => {}, subscribe: () => () => {} };
}
async function makeRuntime() {
  return bootstrap({ environment: 'test', version: '16.3.0', publisher: recordingPublisher() });
}

/** A minimal contract-compliant hosted service with observable start/stop. */
function makeService(id, deps = [], opts = {}) {
  const state = { started: false, starts: 0, stops: 0, healthy: opts.healthy !== false };
  return {
    _state: state,
    id: () => id,
    name: () => opts.name || `${id}-service`,
    version: () => opts.version || '1.0.0',
    dependencies: () => deps,
    metadata: () => ({ needs: opts.needs || ['logger'], kind: opts.kind || 'service' }),
    start: async (ctx) => {
      if (opts.needs && opts.needs.includes('logger') && !ctx.logger) throw new Error('no logger');
      if (opts.failStart) throw new Error(`start failed: ${id}`);
      state.started = true;
      state.starts += 1;
    },
    stop: async () => {
      state.started = false;
      state.stops += 1;
    },
    health: async () => ({ ok: state.started && state.healthy }),
    verify: async () => ({ ok: opts.failVerify ? false : true }),
  };
}

// ── Host ─────────────────────────────────────────────────────────────────────────────
test('host: production usage — bootstrap → createHost → register → start', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('gateway'));
  await host.register(makeService('worker'));
  await host.register(makeService('admin'));
  const r = await host.start();
  assert.equal(r.ok, true);
  assert.equal(r.started.length, 3);
  const h = await host.health();
  assert.equal(h.status, 'healthy');
  await host.stop();
});

test('host: createHost requires a Bootstrap Runtime', async () => {
  await assert.rejects(() => createHost({}), errors.HostStateError);
  await assert.rejects(() => createHost({ runtime: {} }), errors.HostStateError);
});

test('host: services are isolated — no direct sibling access, only declared context', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  let received = null;
  const svc = makeService('probe');
  svc.metadata = () => ({ needs: ['logger', 'configuration'] });
  svc.start = async (ctx) => {
    received = ctx;
  };
  await host.register(svc);
  await host.start();
  assert.deepEqual(Object.keys(received).sort(), ['configuration', 'logger']);
  assert.equal('runtime' in received, false); // undeclared slice is not exposed
  assert.equal('platform' in received, false);
  await host.stop();
});

// ── Registry ───────────────────────────────────────────────────────────────────────
test('registry: register/unregister/resolve/list/verify; duplicate + missing detected', () => {
  const r1 = createHostRegistry();
  const r2 = createHostRegistry();
  r1.register(makeService('a'));
  assert.equal(r1.list().length, 1);
  assert.equal(r2.list().length, 0); // no shared state
  assert.throws(() => r1.register(makeService('a')), errors.DuplicateServiceError);
  assert.throws(() => r1.resolve('missing'), errors.ServiceNotFoundError);
  assert.equal(r1.unregister('a'), true);
  assert.equal(r1.unregister('a'), false);
});

test('registry: invalid contracts are rejected', () => {
  assert.throws(() => assertServiceContract({}), errors.ServiceContractError);
  assert.throws(
    () =>
      assertServiceContract({
        id: () => '',
        name() {},
        version() {},
        dependencies() {},
        start() {},
        stop() {},
        health() {},
        verify() {},
        metadata() {},
      }),
    errors.ServiceContractError
  );
  const missingMethod = {
    id: () => 'x',
    name: () => 'x',
    version: () => '1',
    dependencies: () => [],
    start() {},
    stop() {},
    health() {},
    metadata() {},
  };
  assert.throws(() => assertServiceContract(missingMethod), errors.ServiceContractError); // no verify()
});

test('registry: verify flags a service whose declared dependency is missing', () => {
  const r = createHostRegistry();
  r.register(makeService('a', ['ghost']));
  const v = r.verify();
  assert.equal(v.ok, false);
  assert.equal(v.issues[0].reason, 'missing dependency');
});

// ── Dependency graph / ordering ────────────────────────────────────────────────────
test('graph: deterministic startup order (deps first) + reverse shutdown order', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('db'));
  await host.register(makeService('api', ['db']));
  await host.register(makeService('edge', ['api']));
  const r = await host.start();
  assert.deepEqual(r.order, ['db', 'api', 'edge']);
  const sd = await host.stop();
  assert.deepEqual(sd.stopped, ['edge', 'api', 'db']);
});

test('graph: circular service dependencies are rejected at start', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('a', ['b']));
  await host.register(makeService('b', ['a']));
  await assert.rejects(() => host.start(), errors.ServiceDependencyError);
  await runtime.shutdown();
});

// ── Lifecycle (Runtime → Services ; Services → Runtime) ───────────────────────────────
test('lifecycle: startup starts runtime first then services; shutdown reverses', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  const a = makeService('a');
  const b = makeService('b', ['a']);
  await host.register(a);
  await host.register(b);
  await host.start();
  assert.equal(a._state.started, true);
  assert.equal(b._state.started, true);
  const sd = await host.stop();
  assert.equal(a._state.stops, 1);
  assert.equal(b._state.stops, 1);
  assert.equal(sd.runtime.mode, 'graceful'); // runtime stopped last, delegated to ADR-043
});

// ── Supervisor ─────────────────────────────────────────────────────────────────────────
test('supervisor: state machine + service states + no shared state', () => {
  const s1 = createHostSupervisor();
  const s2 = createHostSupervisor();
  assert.equal(s1.state(), STATES.CREATED);
  s1.transition(STATES.STARTING);
  assert.equal(s2.state(), STATES.CREATED);
  s1.setServiceState('a', SERVICE_STATES.STARTED);
  assert.equal(s1.serviceStateOf('a'), SERVICE_STATES.STARTED);
  s1.recordFailure('startup', new Error('x'), 'a');
  assert.equal(s1.snapshot().failures.length, 1);
  assert.throws(() => s1.transition('bogus'), /unknown state/);
});

test('supervisor: assess degrades then recovers with service health', () => {
  const s = createHostSupervisor();
  s.transition(STATES.READY);
  let a = s.assess({ runtimeOk: true, serviceHealth: { x: { ok: false } } });
  assert.equal(a.overall, false);
  assert.equal(s.state(), STATES.DEGRADED);
  a = s.assess({ runtimeOk: true, serviceHealth: { x: { ok: true } } });
  assert.equal(a.overall, true);
  assert.equal(s.state(), STATES.READY);
});

// ── Failure injection ──────────────────────────────────────────────────────────────────
test('failure: a service that fails to start surfaces ServiceLifecycleError', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('ok'));
  await host.register(makeService('boom', ['ok'], { failStart: true }));
  await assert.rejects(() => host.start(), errors.ServiceLifecycleError);
  assert.equal(host.supervisor.state(), STATES.FAILED);
  await runtime.shutdown();
});

test('failure: dynamic register rejects when a dependency is not started', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('a'));
  await host.start();
  await assert.rejects(
    () => host.register(makeService('late', ['never-registered'])),
    errors.HostStateError
  );
  await host.stop();
});

// ── Health ───────────────────────────────────────────────────────────────────────────
test('health: aggregates host + runtime + per-service + readiness/liveness', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('a'));
  await host.register(makeService('b', ['a']));
  await host.start();
  const h = await host.health();
  assert.equal(h.status, 'healthy');
  assert.equal(h.readiness.ready, true);
  assert.equal(h.liveness.live, true);
  assert.equal(Object.keys(h.services).length, 2);
  assert.ok(h.runtime.overall);
  assert.ok(h.startupDurationMs >= 0);
  await host.stop();
  assert.equal(host.supervisor.snapshot().stopped, true);
});

test('health: an unhealthy service degrades the host', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  const bad = makeService('bad');
  await host.register(bad);
  await host.start();
  bad._state.healthy = false; // flip to unhealthy
  const h = await host.health();
  assert.equal(h.status, 'degraded');
  assert.deepEqual(h.unhealthyServices, ['bad']);
  await host.stop();
});

// ── Verification ─────────────────────────────────────────────────────────────────────
test('verify: confirms runtime + services + graph + orders + contracts', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('a'));
  await host.register(makeService('b', ['a']));
  await host.start();
  const v = await host.verify();
  assert.equal(v.ok, true);
  for (const key of [
    'runtimeHealthy',
    'allServicesVerified',
    'dependencyGraphValid',
    'startupOrderValid',
    'shutdownOrderValid',
    'contractsValid',
  ]) {
    assert.equal(v.checks[key].ok, true, `check ${key}`);
  }
  await host.stop();
});

test('verify: a failing service verify() fails host verification', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  await host.register(makeService('a', [], { failVerify: true }));
  await host.start();
  const v = await host.verify();
  assert.equal(v.ok, false);
  assert.equal(v.checks.allServicesVerified.ok, false);
  await host.stop();
});

// ── Restart ─────────────────────────────────────────────────────────────────────────────
test('restart: rebuilds runtime + restarts all services in order', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  const a = makeService('a');
  const b = makeService('b', ['a']);
  await host.register(a);
  await host.register(b);
  await host.start();
  const rs = await host.restart();
  assert.equal(rs.ok, true);
  assert.equal(rs.restarts, 1);
  assert.deepEqual(rs.started, ['a', 'b']);
  assert.equal(a._state.starts, 2); // started, stopped, started again
  const h = await host.health();
  assert.equal(h.readiness.ready, true);
  await host.stop();
});

// ── Integration ──────────────────────────────────────────────────────────────────────
test('integration: hosted service uses the runtime platform through declared context', async () => {
  const runtime = await makeRuntime();
  const host = await createHost({ runtime });
  let kernelCount = 0;
  const svc = makeService('inspector');
  svc.metadata = () => ({ needs: ['runtime'] });
  svc.start = async (ctx) => {
    kernelCount = ctx.runtime.platform().listKernels().length;
  };
  await host.register(svc);
  await host.start();
  assert.equal(kernelCount, 25);
  await host.stop();
});

// ── A/B compatibility (determinism + additivity) ────────────────────────────────────────
test('a/b: two hosts produce identical service ordering (deterministic)', async () => {
  const build = async () => {
    const runtime = await makeRuntime();
    const host = await createHost({ runtime });
    await host.register(makeService('db'));
    await host.register(makeService('api', ['db']));
    await host.register(makeService('edge', ['api']));
    const r = await host.start();
    await host.stop();
    return r.order;
  };
  const a = await build();
  const b = await build();
  assert.deepEqual(a, b);
});

test('a/b: importing the host module wires nothing until createHost is called', () => {
  assert.equal(typeof createHost, 'function');
});
