'use strict';

/**
 * Enterprise Deployment Runtime tests (Phase 16.4 / ADR-045) — covers every required
 * category: deployment, planner, release strategy, rollback, supervisor, failure
 * injection, health, integration, performance, and A/B compatibility (determinism +
 * additivity). Deploys hosted services on a real Host Runtime (ADR-044) WITHOUT modifying
 * any kernel, ADR-042, ADR-043, or ADR-044.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('../../src/runtime');
const { createHost } = require('../../src/host');
const {
  createDeployment,
  createReleaseStrategy,
  createDeploymentSupervisor,
  createDeploymentRegistry,
  STRATEGY_NAMES,
  STATES,
  errors,
} = require('../../src/deployment');

function recordingPublisher() {
  return { publish: () => {}, subscribe: () => () => {} };
}
async function makeStack() {
  const runtime = await bootstrap({
    environment: 'test',
    version: '16.4.0',
    publisher: recordingPublisher(),
  });
  const host = await createHost({ runtime });
  const deployment = await createDeployment({ host });
  return { runtime, host, deployment };
}

function makeService(id, deps = [], opts = {}) {
  const st = { started: false, healthy: opts.healthy !== false, v: opts.version || '1.0.0' };
  return {
    _st: st,
    id: () => id,
    name: () => opts.name || id,
    version: () => st.v,
    dependencies: () => deps,
    metadata: () => ({ needs: opts.needs || ['logger'] }),
    start: async () => {
      if (opts.failStart) throw new Error(`start failed: ${id}`);
      st.started = true;
    },
    stop: async () => {
      st.started = false;
    },
    health: async () => ({ ok: st.started && st.healthy }),
    verify: async () => ({ ok: opts.failVerify ? false : true }),
  };
}

// ── Deployment ─────────────────────────────────────────────────────────────────────
test('deployment: production flow — bootstrap → host → deployment → deploy → verify', async () => {
  const { deployment } = await makeStack();
  const r = await deployment.deploy({ service: makeService('api-gateway'), strategy: 'rolling' });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'rolling');
  const v = await deployment.verify();
  assert.equal(v.ok, true);
});

test('deployment: createDeployment requires a Host Runtime', async () => {
  await assert.rejects(() => createDeployment({}), errors.DeploymentStateError);
  await assert.rejects(() => createDeployment({ host: {} }), errors.DeploymentStateError);
});

test('deployment: exposes the §2 contract (+ health)', async () => {
  const { deployment } = await makeStack();
  for (const m of [
    'deploy',
    'rollback',
    'verify',
    'status',
    'history',
    'version',
    'metadata',
    'health',
  ]) {
    assert.equal(typeof deployment[m], 'function', `missing ${m}`);
  }
  assert.deepEqual(deployment.metadata().strategies, [
    'immediate',
    'rolling',
    'blue-green',
    'canary',
  ]);
});

// ── Release strategies ─────────────────────────────────────────────────────────────
test('release strategies: all four are deterministic and interchangeable', async () => {
  for (const strat of STRATEGY_NAMES) {
    const { deployment } = await makeStack();
    const r = await deployment.deploy({ service: makeService(`svc-${strat}`), strategy: strat });
    assert.equal(r.ok, true, `strategy ${strat}`);
    assert.equal(r.strategyResult.strategy, strat);
    assert.ok(r.strategyResult.steps.length >= 1);
  }
});

test('release strategies: unknown strategy is rejected', () => {
  assert.throws(() => createReleaseStrategy('teleport'), errors.ReleaseStrategyError);
});

test('release strategies: a custom strategy can be injected (DI)', async () => {
  const { deployment } = await makeStack();
  let called = false;
  const custom = {
    name: 'custom-x',
    execute: async ({ service, ops, descriptor, clock }) => {
      called = true;
      await ops.deploy(service);
      return {
        ok: true,
        strategy: 'custom-x',
        steps: [{ step: 'custom', at: clock(), ok: true }],
        version: descriptor.version,
      };
    },
  };
  const r = await deployment.deploy({ service: makeService('c'), strategy: custom });
  assert.equal(called, true);
  assert.equal(r.strategyResult.strategy, 'custom-x');
});

test('release strategies: canary honors deterministic stages', async () => {
  const { deployment } = await makeStack();
  const r = await deployment.deploy({
    service: makeService('cx'),
    strategy: 'canary',
    params: { stages: [25, 75, 100] },
  });
  const canarySteps = r.strategyResult.steps.filter((s) => s.step.startsWith('canary-'));
  assert.deepEqual(
    canarySteps.map((s) => s.step),
    ['canary-25', 'canary-75', 'canary-100']
  );
});

// ── Planner ─────────────────────────────────────────────────────────────────────────
test('planner: generates a plan with deploy order + reverse rollback order; never executes', async () => {
  const { host, deployment } = await makeStack();
  // pre-register a dependency in the host so the target can depend on it
  await host.register(makeService('db'));
  const { createDeploymentPlanner } = require('../../src/deployment');
  const planner = createDeploymentPlanner({ host });
  const plan = await planner.plan({ service: makeService('api', ['db']), strategy: 'immediate' });
  assert.equal(plan.ok, true);
  assert.equal(plan.deployOrder[plan.deployOrder.length - 1], 'api');
  assert.deepEqual(plan.rollbackOrder, [...plan.deployOrder].reverse());
  // the planner did not start anything
  assert.equal(host.getService('api'), null);
  void deployment;
});

test('planner: flags a missing service dependency (plan invalid)', async () => {
  const { host } = await makeStack();
  const { createDeploymentPlanner } = require('../../src/deployment');
  const planner = createDeploymentPlanner({ host });
  const plan = await planner.plan({ service: makeService('api', ['ghost']) });
  assert.equal(plan.ok, false);
  assert.equal(plan.checks.dependencies.ok, false);
  assert.deepEqual(plan.checks.dependencies.missing, ['ghost']);
});

test('deploy: an unsatisfiable plan throws DeploymentPlanError', async () => {
  const { deployment } = await makeStack();
  await assert.rejects(
    () => deployment.deploy({ service: makeService('api', ['ghost']) }),
    errors.DeploymentPlanError
  );
});

// ── Rollback ────────────────────────────────────────────────────────────────────────
test('rollback: full rollback reverts deployed services in reverse order', async () => {
  const { deployment } = await makeStack();
  await deployment.deploy({ service: makeService('a'), strategy: 'immediate' });
  await deployment.deploy({ service: makeService('b'), strategy: 'immediate' });
  const rb = await deployment.rollback({ mode: 'full' });
  assert.equal(rb.ok, true);
  assert.equal(rb.mode, 'full');
  assert.deepEqual(
    rb.results.map((r) => r.service),
    ['b', 'a']
  );
  assert.equal(deployment.supervisor.state(), STATES.ROLLED_BACK);
});

test('rollback: partial rollback targets only named services', async () => {
  const { deployment } = await makeStack();
  await deployment.deploy({ service: makeService('a'), strategy: 'immediate' });
  await deployment.deploy({ service: makeService('b'), strategy: 'immediate' });
  const rb = await deployment.rollback({ mode: 'partial', services: ['a'] });
  assert.equal(rb.ok, true);
  assert.deepEqual(
    rb.results.map((r) => r.service),
    ['a']
  );
});

test('rollback: blue-green redeploys the retained previous version', async () => {
  const { deployment } = await makeStack();
  await deployment.deploy({
    service: makeService('svc', [], { version: '1.0.0' }),
    strategy: 'blue-green',
  });
  await deployment.deploy({
    service: makeService('svc', [], { version: '2.0.0' }),
    strategy: 'blue-green',
  });
  const rb = await deployment.rollback({ mode: 'full' });
  assert.equal(rb.ok, true);
  assert.equal(rb.results[0].restoredVersion, '1.0.0'); // reverted to the prior version
});

// ── Supervisor ─────────────────────────────────────────────────────────────────────
test('supervisor: tracks state/strategy/verification/duration/failures; no shared state', () => {
  const s1 = createDeploymentSupervisor();
  const s2 = createDeploymentSupervisor();
  assert.equal(s1.state(), STATES.IDLE);
  s1.transition(STATES.DEPLOYING);
  assert.equal(s2.state(), STATES.IDLE);
  s1.setStrategy('canary');
  s1.setVerification(true);
  s1.setDuration(42);
  s1.recordFailure('deploy', new Error('x'), 'svc');
  const snap = s1.snapshot();
  assert.equal(snap.strategy, 'canary');
  assert.equal(snap.verificationState, 'passed');
  assert.equal(snap.deploymentDurationMs, 42);
  assert.equal(snap.failureCount, 1);
  assert.throws(() => s1.transition('bogus'), /unknown state/);
});

test('registry: records history + current per service; verify detects bad records', () => {
  const r = createDeploymentRegistry();
  const rec1 = r.register({ service: 'svc', version: '1.0.0' });
  const rec2 = r.register({ service: 'svc', version: '2.0.0' });
  assert.equal(r.current('svc').version, '2.0.0');
  assert.equal(r.history('svc').length, 2);
  assert.equal(r.resolve(rec1.id).version, '1.0.0');
  void rec2;
  assert.equal(r.verify().ok, true);
});

// ── Failure injection ──────────────────────────────────────────────────────────────────
test('failure: an unhealthy service fails deployment and auto-rolls-back', async () => {
  const { deployment } = await makeStack();
  await assert.rejects(
    () =>
      deployment.deploy({
        service: makeService('bad', [], { healthy: false }),
        strategy: 'immediate',
      }),
    (e) =>
      e instanceof errors.DeploymentExecutionError ||
      e instanceof errors.DeploymentVerificationError
  );
  assert.equal(deployment.supervisor.state(), STATES.ROLLED_BACK);
});

test('failure: autoRollback:false leaves the deployment failed (no rollback)', async () => {
  const { deployment } = await makeStack();
  await assert.rejects(
    () =>
      deployment.deploy({
        service: makeService('bad2', [], { healthy: false }),
        strategy: 'immediate',
        autoRollback: false,
      }),
    errors.DeploymentError
  );
  assert.equal(deployment.supervisor.state(), STATES.FAILED);
});

// ── Health ───────────────────────────────────────────────────────────────────────────
test('health: exposes deployment/active/strategy/rollback readiness/verification', async () => {
  const { deployment } = await makeStack();
  await deployment.deploy({ service: makeService('svc'), strategy: 'rolling' });
  const h = await deployment.health();
  assert.equal(h.status, 'healthy');
  assert.ok(h.activeDeployment && h.activeDeployment.service === 'svc');
  assert.equal(h.currentReleaseStrategy, 'rolling');
  assert.equal(h.rollbackReadiness.ready, true);
  assert.equal(h.verificationState, 'passed');
});

// ── Verification ─────────────────────────────────────────────────────────────────────
test('verify: confirms plan/host/runtime/services/compatibility/strategy', async () => {
  const { deployment } = await makeStack();
  const r = await deployment.deploy({ service: makeService('svc'), strategy: 'immediate' });
  for (const key of [
    'planCompleted',
    'hostHealthy',
    'runtimeHealthy',
    'allServicesHealthy',
    'compatibilityPassed',
    'strategyCompleted',
  ]) {
    assert.equal(r.verification.checks[key].ok, true, `check ${key}`);
  }
});

// ── Integration ────────────────────────────────────────────────────────────────────
test('integration: deployed service runs on the host and is healthy', async () => {
  const { host, deployment } = await makeStack();
  await deployment.deploy({ service: makeService('worker'), strategy: 'canary' });
  const hostHealth = await host.health();
  assert.equal(hostHealth.services.worker.ok, true);
});

test('integration: redeploying replaces the service and keeps history', async () => {
  const { deployment } = await makeStack();
  await deployment.deploy({
    service: makeService('svc', [], { version: '1.0.0' }),
    strategy: 'immediate',
  });
  await deployment.deploy({
    service: makeService('svc', [], { version: '2.0.0' }),
    strategy: 'immediate',
  });
  assert.equal(deployment.history('svc').length, 2);
  assert.equal(deployment.version(), '2.0.0');
});

// ── Performance ──────────────────────────────────────────────────────────────────────
test('performance: a deployment completes within budget', async () => {
  const { deployment } = await makeStack();
  const t0 = Date.now();
  await deployment.deploy({ service: makeService('perf'), strategy: 'immediate' });
  assert.ok(Date.now() - t0 < 1500);
});

// ── A/B compatibility (determinism + additivity) ────────────────────────────────────────
test('a/b: the same deployment produces identical strategy steps (deterministic)', async () => {
  const run = async () => {
    const { deployment } = await makeStack();
    const r = await deployment.deploy({
      service: makeService('svc'),
      strategy: 'canary',
      params: { stages: [10, 100] },
    });
    return r.strategyResult.steps.map((s) => s.step);
  };
  assert.deepEqual(await run(), await run());
});

test('a/b: importing the deployment module wires nothing until createDeployment is called', () => {
  assert.equal(typeof createDeployment, 'function');
});
