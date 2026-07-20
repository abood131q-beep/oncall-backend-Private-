'use strict';

/**
 * Workflow Engine — production hardening tests (ADR-023 A-001). Additive:
 * snapshot immutability, transition-history ring buffer, corruption detection,
 * startup + integrity verification, workflow recovery + scheduler reconciliation,
 * failure injection (storage/lock/action), diagnostics/history, and expanded
 * metrics. Does not duplicate workflow.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStoragePlatform } = require('../../src/application/storage');
const { createLockPlatform } = require('../../src/application/lock');
const { createSchedulerPlatform } = require('../../src/application/scheduler');
const { createWorkflowPlatform } = require('../../src/application/workflow');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}
function tripDef(extra = {}) {
  return {
    name: 'trip',
    initial: 'requested',
    states: {
      requested: { onTimeout: { afterMs: 5000, to: 'expired' } },
      accepted: {},
      completed: { terminal: true },
      expired: { terminal: true, failure: true },
    },
    transitions: [
      {
        from: 'requested',
        on: 'accept',
        to: 'accepted',
        guard: (c) => !!c.rider,
        action: (c, p) => ({ driver: p.driver }),
      },
      { from: 'accepted', on: 'finish', to: 'completed' },
    ],
    ...extra,
  };
}
function loop() {
  // a 2-state ping-pong definition to exercise the history ring buffer
  return {
    name: 'loop',
    initial: 'a',
    states: { a: {}, b: {} },
    transitions: [
      { from: 'a', on: 'go', to: 'b' },
      { from: 'b', on: 'go', to: 'a' },
    ],
  };
}
function makePlatform(clock, opts = {}) {
  const st = createStoragePlatform({ clock });
  const lk = createLockPlatform({ clock });
  const sc = createSchedulerPlatform({ clock });
  const wf = createWorkflowPlatform({
    storage: st.storage,
    lock: lk.lock,
    scheduler: sc.scheduler,
    clock,
    ...opts,
  });
  return { st, lk, sc, wf, engine: wf.engine };
}

// ── snapshot immutability ────────────────────────────────────────────────────

test('hardening: snapshot() is deeply immutable', async () => {
  const { engine } = makePlatform(makeClock());
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  const snap = await engine.snapshot(w.workflowId);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.context));
  assert.throws(() => {
    snap.state = 'hacked';
  }, TypeError);
  assert.equal(await engine.snapshot('nope'), null);
});

// ── transition-history ring buffer ──────────────────────────────────────────

test('hardening: transition history is bounded by historyLimit', async () => {
  const { engine } = makePlatform(makeClock(), { historyLimit: 5 });
  engine.register(loop());
  const w = await engine.start({ definitionName: 'loop', input: {} });
  for (let i = 0; i < 20; i++) await engine.signal({ workflowId: w.workflowId, event: 'go' });
  const model = await engine.get(w.workflowId);
  assert.ok(model.history.length <= 5, `history ${model.history.length} exceeds cap`);
  assert.equal(model.state, 'a'); // 20 flips → back to 'a'
});

// ── corruption detection ────────────────────────────────────────────────────

test('hardening: a corrupt persisted record is detected, not trusted', async () => {
  const clock = makeClock();
  const st = createStoragePlatform({ clock });
  const wf = createWorkflowPlatform({ storage: st.storage, clock });
  wf.engine.register(tripDef());
  // Write a structurally broken record directly into storage.
  await st.storage.put({
    namespace: 'workflow',
    collection: 'instances',
    key: 'broken',
    value: { workflowId: 'broken', definitionName: 'trip' }, // missing state/status/version
  });
  await assert.rejects(
    () => wf.engine.signal({ workflowId: 'broken', event: 'accept' }),
    /corrupt/
  );
  const v = await wf.engine.verifyWorkflow('broken');
  assert.equal(v.ok, false);
});

// ── startup + integrity verification ────────────────────────────────────────

test('hardening: verifyStartup + verifyWorkflow', async () => {
  const { engine } = makePlatform(makeClock());
  engine.register(tripDef());
  const s = engine.verifyStartup();
  assert.equal(s.ok, true);
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  await engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd1' } });
  const v = await engine.verifyWorkflow(w.workflowId);
  assert.equal(v.ok, true, v.issues.join(';'));
});

// ── workflow recovery + scheduler reconciliation ────────────────────────────

test('hardening: recover() re-arms timeouts for running workflows (restart)', async () => {
  const clock = makeClock(1000);
  // First platform starts a workflow with a pending timeout, then is "lost".
  const st = createStoragePlatform({ clock });
  const p1 = createWorkflowPlatform({
    storage: st.storage,
    scheduler: createSchedulerPlatform({ clock }).scheduler,
    clock,
  });
  p1.engine.register(tripDef());
  const w = await p1.engine.start({ definitionName: 'trip', input: { rider: 'r1' } });

  // A fresh engine + fresh scheduler share the same storage (simulated restart).
  const sc2 = createSchedulerPlatform({ clock });
  const p2 = createWorkflowPlatform({ storage: st.storage, scheduler: sc2.scheduler, clock });
  p2.engine.register(tripDef());
  const rec = await p2.engine.recover();
  assert.deepEqual(rec.recovered, [w.workflowId]);
  assert.equal(p2.engine.metrics().schedulerReconciliations, 1);
  // The re-armed timer now fires on the new scheduler.
  clock.set(7000);
  await sc2.scheduler.tick(7000);
  assert.equal((await p2.engine.get(w.workflowId)).state, 'expired');
});

test('hardening: recover reports corrupt records without throwing', async () => {
  const clock = makeClock();
  const st = createStoragePlatform({ clock });
  const wf = createWorkflowPlatform({ storage: st.storage, clock });
  wf.engine.register(tripDef());
  await st.storage.put({
    namespace: 'workflow',
    collection: 'instances',
    key: 'bad',
    value: { workflowId: 'bad' },
  });
  const rec = await wf.engine.recover();
  assert.equal(rec.ok, true);
  assert.equal(rec.corrupt.length, 1);
  assert.equal(rec.corrupt[0].workflowId, 'bad');
});

// ── failure injection: storage ───────────────────────────────────────────────

test('hardening: a storage failure surfaces + increments storageFailures', async () => {
  const clock = makeClock();
  const st = createStoragePlatform({ clock });
  let failPut = false;
  const original = st.storage.put.bind(st.storage);
  const wrapped = {
    ...st.storage,
    put: (spec) => (failPut ? Promise.reject(new Error('disk full')) : original(spec)),
  };
  const wf = createWorkflowPlatform({ storage: wrapped, clock });
  wf.engine.register(tripDef());
  const w = await wf.engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  failPut = true;
  await assert.rejects(
    () =>
      wf.engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd1' } }),
    /disk full/
  );
  assert.ok(wf.engine.metrics().storageFailures >= 1);
  // State unchanged (the failed transition did not persist a new state on read-back).
  failPut = false;
  assert.equal((await wf.engine.get(w.workflowId)).state, 'requested');
});

// ── failure injection: action throwing ───────────────────────────────────────

test('hardening: a throwing action rejects the signal and does not transition', async () => {
  const { engine } = makePlatform(makeClock());
  engine.register({
    name: 'act',
    initial: 's0',
    states: { s0: {}, s1: {} },
    transitions: [
      {
        from: 's0',
        on: 'go',
        to: 's1',
        action: () => {
          throw new Error('action boom');
        },
      },
    ],
  });
  const w = await engine.start({ definitionName: 'act', input: {} });
  await assert.rejects(
    () => engine.signal({ workflowId: w.workflowId, event: 'go' }),
    /action boom/
  );
  assert.equal((await engine.get(w.workflowId)).state, 's0'); // no transition
});

// ── diagnostics + history + metrics ──────────────────────────────────────────

test('hardening: diagnostics, engine history, and expanded metrics', async () => {
  const { engine } = makePlatform(makeClock());
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  await engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd1' } });
  await engine.signal({ workflowId: w.workflowId, event: 'finish' });
  const d = engine.diagnostics();
  assert.equal(d.wiring.storage, true);
  assert.equal(d.wiring.lock, true);
  assert.ok(d.startup.ok);
  const hist = engine.history().map((h) => h.type);
  assert.ok(hist.includes('WorkflowStarted'));
  assert.ok(hist.includes('WorkflowCompleted'));
  const m = engine.metrics();
  assert.ok(m.avgWorkflowDurationMs >= 0);
  assert.ok('lockConflicts' in m && 'storageFailures' in m && 'eventPublicationFailures' in m);
});

// ── stress ───────────────────────────────────────────────────────────────────

test('hardening: stress — 500 workflows recover cleanly', async () => {
  const clock = makeClock();
  const st = createStoragePlatform({ clock });
  const p1 = createWorkflowPlatform({
    storage: st.storage,
    scheduler: createSchedulerPlatform({ clock }).scheduler,
    clock,
  });
  p1.engine.register(tripDef());
  for (let i = 0; i < 500; i++)
    await p1.engine.start({ definitionName: 'trip', input: { rider: 'r' + i } });
  const p2 = createWorkflowPlatform({
    storage: st.storage,
    scheduler: createSchedulerPlatform({ clock }).scheduler,
    clock,
  });
  p2.engine.register(tripDef());
  const rec = await p2.engine.recover();
  assert.equal(rec.recovered.length, 500);
  assert.equal(rec.corrupt.length, 0);
});
