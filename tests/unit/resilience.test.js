'use strict';

/**
 * Enterprise Resilience Kernel tests (Phase 15.7 / ADR-036) — covers every required
 * category: unit (policy value object, circuit state machine, classification), circuit
 * breaker, retry, timeout, fallback, bulkhead, provider (+ future extension points),
 * concurrency, stress, failure injection, and performance, plus events-via-port and
 * the SDK owner-scoped adapter (namespace isolation + capability gates). Deterministic:
 * clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPolicy, fromModel, computeChecksum } = require('../../src/domain/resilience/policy');
const circuit = require('../../src/domain/resilience/circuit');
const { classify } = require('../../src/domain/resilience/classify');
const { createResiliencePlatform, providers } = require('../../src/application/resilience');
const { createResilienceMetrics } = require('../../src/application/resilience/metrics');
const { toResiliencePort } = require('../../src/application/resilience/sdkAdapter');
const {
  ResilienceValidationError,
  PolicyNotFoundError,
  CircuitOpenError,
  BulkheadFullError,
} = require('../../src/domain/resilience/errors');

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
  const rk = createResiliencePlatform({ clock, publisher: pub, ...extra });
  return { rk, R: rk.resilience, pub };
}

// ── domain: policy value object + checksum ────────────────────────────────────────

test('policy: create, validation, checksum, backoff', () => {
  const clock = makeClock();
  const p = createPolicy(
    {
      name: 'x',
      failureThreshold: 3,
      successThreshold: 2,
      recoveryWindow: 5000,
      retryPolicy: { maxAttempts: 3 },
      backoffPolicy: { baseMs: 100, factor: 2 },
    },
    { clock }
  );
  assert.equal(p.failureThreshold, 3);
  assert.equal(p.nextDelayMs(1), 100);
  assert.equal(p.nextDelayMs(2), 200);
  assert.ok(p.verifyChecksum());
  const re = fromModel(p.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createPolicy({ failureThreshold: 0 }), ResilienceValidationError);
  assert.throws(() => createPolicy({ strategy: 'nope' }), ResilienceValidationError);
});

// ── domain: circuit state machine ──────────────────────────────────────────────────

test('circuit: closed→open→half_open→closed transitions', () => {
  const clock = makeClock(1000);
  const p = createPolicy(
    { failureThreshold: 2, successThreshold: 2, recoveryWindow: 1000 },
    { clock }
  );
  let s = circuit.initialState();
  s = circuit.onFailure(s, p, 1000).state;
  assert.equal(s.state, 'closed'); // 1 failure < threshold
  const opened = circuit.onFailure(s, p, 1000);
  assert.equal(opened.transitioned, 'open'); // 2 failures → open
  s = opened.state;
  // open blocks until recovery window
  assert.equal(circuit.canAttempt(s, p, 1500).allowed, false);
  const half = circuit.canAttempt(s, p, 2000); // window elapsed
  assert.equal(half.transitioned, 'half_open');
  s = half.state;
  s = circuit.onSuccess(s, p, 2000).state; // 1 success
  const closed = circuit.onSuccess(s, p, 2000); // 2 successes → closed
  assert.equal(closed.transitioned, 'closed');
  // a failure in half_open re-opens
  const reopened = circuit.onFailure(half.state, p, 2000);
  assert.equal(reopened.transitioned, 'open');
});

test('classify: retriable vs non-retriable', () => {
  assert.equal(classify(new Error('x')).retriable, true);
  assert.equal(classify({ name: 'ValidationError' }).retriable, false);
  assert.equal(classify({ name: 'ExecutionTimeoutError' }).type, 'timeout');
  assert.equal(classify({ retriable: false }).retriable, false);
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createResilienceMetrics({ clock: () => 0 });
  m.bindGauges({ policies: () => 2, openCircuits: () => 1, closedCircuits: () => 3 });
  m.recordExecution();
  m.recordSuccess();
  m.recordRetry();
  const s = m.snapshot();
  assert.equal(s.registeredPolicies, 2);
  assert.equal(s.openCircuits, 1);
  assert.equal(s.retryAttempts, 1);
  assert.match(m.prometheus(), /resilience_open_circuits 1/);
  assert.match(m.prometheus(), /resilience_retry_attempts_total 1/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory persists policies + state; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putPolicy('n', { policyId: 'p1', strategy: 'composite' });
  assert.equal((await mem.getPolicy('n', 'p1')).strategy, 'composite');
  await mem.putState('n', 'k', { state: 'open' });
  assert.equal((await mem.getState('n', 'k')).state, 'open');
  assert.equal(await mem.resetState('n', 'k'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('redis'));
  const p = providers.futureProvider('postgresql');
  assert.equal(p.planned, true);
  assert.throws(() => p.putPolicy('n', {}), /extension point/);
});

// ── execute: success + events ───────────────────────────────────────────────────────

test('resilience: execute wraps a successful call; events', async () => {
  const clock = makeClock(1000);
  const { R, pub } = platform(clock);
  const p = await R.registerPolicy({ name: 'ok', retryPolicy: { maxAttempts: 3 } });
  const r = await R.execute({ policyId: p.policyId, fn: async () => 42 });
  assert.equal(r.ok, true);
  assert.equal(r.result, 42);
  assert.equal(r.attempts, 1);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('PolicyRegistered') &&
      types.includes('ExecutionStarted') &&
      types.includes('ExecutionSucceeded')
  );
  assert.ok(pub.events.every((e) => e.producer === 'resilience'));
  await assert.rejects(() => R.execute({ policyId: p.policyId }), ResilienceValidationError); // no fn
  await assert.rejects(
    () => R.execute({ policyId: 'ghost', fn: async () => 1 }),
    PolicyNotFoundError
  );
});

// ── retry ──────────────────────────────────────────────────────────────────────────

test('resilience: retries a transient failure then succeeds', async () => {
  const clock = makeClock();
  const { R, rk } = platform(clock);
  const p = await R.registerPolicy({
    name: 'flaky',
    retryPolicy: { maxAttempts: 3 },
    backoffPolicy: { baseMs: 10 },
  });
  let n = 0;
  const r = await R.execute({
    policyId: p.policyId,
    fn: async () => {
      n += 1;
      if (n < 3) throw new Error('transient');
      return 'ok';
    },
  });
  assert.equal(r.result, 'ok');
  assert.equal(r.attempts, 3);
  assert.ok(rk.resilience.metrics().retryAttempts >= 2);
});

test('resilience: non-retriable error is not retried', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const p = await R.registerPolicy({ name: 'v', retryPolicy: { maxAttempts: 5 } });
  let n = 0;
  await assert.rejects(() =>
    R.execute({
      policyId: p.policyId,
      fn: async () => {
        n += 1;
        const e = new Error('bad');
        e.retriable = false;
        throw e;
      },
    })
  );
  assert.equal(n, 1); // no retries
});

// ── timeout ─────────────────────────────────────────────────────────────────────────

test('resilience: execution exceeding timeout is a failure (retriable)', async () => {
  const clock = makeClock(1000);
  const { R, rk } = platform(clock);
  const p = await R.registerPolicy({ name: 't', timeout: 1000, retryPolicy: { maxAttempts: 1 } });
  await assert.rejects(
    () =>
      R.execute({
        policyId: p.policyId,
        fn: async () => {
          clock.set(clock() + 5000);
          return 'late';
        },
      }),
    /timeout/
  );
  assert.ok(rk.resilience.metrics().timeouts >= 1);
});

// ── fallback ─────────────────────────────────────────────────────────────────────────

test('resilience: fallback runs when the primary fails', async () => {
  const clock = makeClock();
  const { R, pub } = platform(clock);
  const p = await R.registerPolicy({
    name: 'fb',
    retryPolicy: { maxAttempts: 1 },
    fallbackStrategy: 'function',
  });
  const r = await R.execute({
    policyId: p.policyId,
    fn: async () => {
      throw new Error('down');
    },
    fallback: async () => 'cached',
  });
  assert.equal(r.fallback, true);
  assert.equal(r.result, 'cached');
  assert.ok(pub.events.some((e) => e.type === 'FallbackExecuted'));
});

// ── circuit breaker (integration) ────────────────────────────────────────────────────

test('resilience: circuit opens after threshold, short-circuits, then recovers', async () => {
  const clock = makeClock(1000);
  const { R, pub } = platform(clock);
  const p = await R.registerPolicy({
    name: 'cb',
    failureThreshold: 2,
    successThreshold: 1,
    recoveryWindow: 1000,
    retryPolicy: { maxAttempts: 1 },
  });
  const fail = () =>
    R.execute({
      policyId: p.policyId,
      fn: async () => {
        throw new Error('x');
      },
    });
  await assert.rejects(fail); // failure 1
  await assert.rejects(fail); // failure 2 → circuit opens
  assert.ok(pub.events.some((e) => e.type === 'CircuitOpened'));
  // now short-circuited (CircuitOpenError, primary not called)
  let called = false;
  await assert.rejects(
    () =>
      R.execute({
        policyId: p.policyId,
        fn: async () => {
          called = true;
          return 1;
        },
      }),
    CircuitOpenError
  );
  assert.equal(called, false);
  // after recovery window → half-open trial → success closes it
  clock.set(2500);
  const r = await R.execute({ policyId: p.policyId, fn: async () => 'recovered' });
  assert.equal(r.result, 'recovered');
  assert.ok(pub.events.some((e) => e.type === 'CircuitClosed'));
  assert.ok(pub.events.some((e) => e.type === 'RecoveryCompleted'));
  const ev = await R.evaluate({ policyId: p.policyId });
  assert.equal(ev.circuit, 'closed');
});

test('resilience: reset clears circuit state', async () => {
  const clock = makeClock(1000);
  const { R } = platform(clock);
  const p = await R.registerPolicy({
    name: 'r',
    failureThreshold: 1,
    retryPolicy: { maxAttempts: 1 },
  });
  await assert.rejects(() =>
    R.execute({
      policyId: p.policyId,
      fn: async () => {
        throw new Error('x');
      },
    })
  );
  assert.equal((await R.evaluate({ policyId: p.policyId })).circuit, 'open');
  assert.equal(await R.reset({ policyId: p.policyId }), true);
  assert.equal((await R.evaluate({ policyId: p.policyId })).circuit, 'closed');
});

// ── bulkhead ─────────────────────────────────────────────────────────────────────────

test('resilience: bulkhead rejects concurrency beyond the limit', async () => {
  const clock = makeClock();
  const { R, rk } = platform(clock);
  const p = await R.registerPolicy({
    name: 'bh',
    bulkhead: { maxConcurrent: 2 },
    retryPolicy: { maxAttempts: 1 },
  });
  let release;
  const gate = new Promise((res) => (release = res));
  const slow = () =>
    R.execute({
      policyId: p.policyId,
      fn: async () => {
        await gate;
        return 'done';
      },
    });
  const a = slow();
  const b = slow();
  // third concurrent execution exceeds the bulkhead → rejected
  await assert.rejects(
    () => R.execute({ policyId: p.policyId, fn: async () => 'x' }),
    BulkheadFullError
  );
  release();
  await Promise.all([a, b]);
  assert.ok(rk.resilience.metrics().bulkheadRejections >= 1);
});

test('resilience: bulkhead full falls back when a fallback is provided', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const p = await R.registerPolicy({
    name: 'bh2',
    bulkhead: { maxConcurrent: 1 },
    retryPolicy: { maxAttempts: 1 },
  });
  let release;
  const gate = new Promise((res) => (release = res));
  const a = R.execute({
    policyId: p.policyId,
    fn: async () => {
      await gate;
      return 1;
    },
  });
  const r = await R.execute({
    policyId: p.policyId,
    fn: async () => 2,
    fallback: async () => 'fb',
  });
  assert.equal(r.fallback, true);
  assert.equal(r.result, 'fb');
  release();
  await a;
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('resilience: verify + execute detect a tampered policy', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { R } = platform(clock, { provider });
  const p = await R.registerPolicy({ name: 'v', failureThreshold: 3 });
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getPolicy('default', p.policyId);
  await provider.putPolicy('default', { ...stored, failureThreshold: 999 });
  const v = await R.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  await assert.rejects(() => R.execute({ policyId: p.policyId, fn: async () => 1 }), /integrity/);
});

// ── SDK adapter ─────────────────────────────────────────────────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no authoring', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  await R.registerPolicy(
    { name: 'p', retryPolicy: { maxAttempts: 1 } },
    { namespace: 'ext.alice' }
  );
  const listed = await R.list({ namespace: 'ext.alice' });
  const alice = toResiliencePort(R, { owner: 'alice' });
  const r = await alice.execute({ policyId: listed[0].policyId, fn: async () => 'ok' });
  assert.equal(r.result, 'ok');
  assert.equal(typeof alice.registerPolicy, 'undefined'); // no authoring
  assert.equal(typeof alice.reset, 'undefined'); // no reset
  const noExec = toResiliencePort(R, { owner: 'x', canExecute: false });
  await assert.rejects(
    async () => noExec.execute({ policyId: 'p', fn: async () => 1 }),
    /resilience:execute/
  );
  const noRead = toResiliencePort(R, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.evaluate({ policyId: 'p' }), /resilience:read/);
  assert.throws(() => toResiliencePort(R, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('resilience: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putPolicy: () => Promise.reject(new Error('db down')),
    getPolicy: () => Promise.resolve(null),
    listPolicies: () => Promise.resolve([]),
    removePolicy: () => Promise.resolve(false),
    getState: () => Promise.resolve(null),
    putState: () => Promise.resolve(),
    resetState: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { R, rk } = platform(clock, { provider: failing });
  await assert.rejects(() => R.registerPolicy({ name: 'x' }), /db down/);
  assert.ok(rk.resilience.metrics().providerFailures >= 1);
  assert.equal((await R.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('resilience: concurrent executions on independent policies all succeed', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const ids = [];
  for (let i = 0; i < 20; i++)
    ids.push((await R.registerPolicy({ name: 'p' + i, retryPolicy: { maxAttempts: 1 } })).policyId);
  const results = await Promise.all(
    ids.map((id) => R.execute({ policyId: id, fn: async () => id }))
  );
  assert.equal(results.filter((r) => r.ok).length, 20);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('resilience: stress — 1000 protected executions fast + consistent', async () => {
  const clock = makeClock();
  const { R, rk } = platform(clock);
  const p = await R.registerPolicy({
    name: 's',
    retryPolicy: { maxAttempts: 2 },
    failureThreshold: 100000,
  });
  const start = Date.now();
  let ok = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await R.execute({ policyId: p.policyId, subject: 'u' + (i % 50), fn: async () => i });
    if (r.ok) ok += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(ok, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal(rk.resilience.metrics().successfulExecutions, 1000);
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
});

test('policy checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { R, rk } = platform(clock);
  const p = await R.registerPolicy({ name: 'x', failureThreshold: 3 });
  const model = await rk.provider.getPolicy('default', p.policyId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
