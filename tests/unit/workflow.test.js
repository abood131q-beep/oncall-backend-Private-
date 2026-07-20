'use strict';

/**
 * Enterprise Workflow Engine tests (Phase 14.4 / ADR-023) — the first INTEGRATED
 * kernel component. Covers: definition + instance (unit), transition/guard/action,
 * timeout via the real Scheduler, lock-guarded concurrency, Storage persistence,
 * lifecycle events via the Event Backbone port, cancel, cross-kernel integration,
 * the SDK owner-scoped adapter, and a stress run. Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDefinition } = require('../../src/domain/workflow/definition');
const { createInstance } = require('../../src/domain/workflow/instance');
const {
  DefinitionError,
  TransitionError,
  GuardRejectedError,
  InvalidStateError,
} = require('../../src/domain/workflow/errors');
const { createStoragePlatform } = require('../../src/application/storage');
const { createLockPlatform } = require('../../src/application/lock');
const { createSchedulerPlatform } = require('../../src/application/scheduler');
const { createWorkflowPlatform } = require('../../src/application/workflow');
const { toWorkflowPort } = require('../../src/application/workflow/sdkAdapter');

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

// A representative trip definition reused across tests.
function tripDef() {
  return {
    name: 'trip',
    initial: 'requested',
    states: {
      requested: { onTimeout: { afterMs: 5000, to: 'expired' } },
      accepted: {},
      completed: { terminal: true },
      expired: { terminal: true, failure: true },
      cancelled: { terminal: true },
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
  };
}

// Wire the integrated platform (all kernels share one clock + publisher).
function makePlatform(clock, publisher) {
  const st = createStoragePlatform({ clock, publisher });
  const lk = createLockPlatform({ clock, publisher });
  const sc = createSchedulerPlatform({ clock, publisher });
  const wf = createWorkflowPlatform({
    storage: st.storage,
    lock: lk.lock,
    scheduler: sc.scheduler,
    publisher,
    clock,
  });
  return { st, lk, sc, wf, engine: wf.engine };
}

// ── domain: definition validation ─────────────────────────────────────────────

test('definition: validates states/transitions/timeout targets', () => {
  const def = createDefinition(tripDef());
  assert.equal(def.initial, 'requested');
  assert.ok(def.isTerminal('completed'));
  assert.ok(def.isFailureState('expired'));
  assert.equal(def.findTransition('requested', 'accept').to, 'accepted');
  assert.equal(def.timeoutFor('requested').to, 'expired');
  assert.throws(
    () => createDefinition({ name: 'x', initial: 'a', states: {}, transitions: [] }),
    DefinitionError
  );
  assert.throws(
    () =>
      createDefinition({
        name: 'x',
        initial: 'a',
        states: { a: {} },
        transitions: [{ from: 'a', on: 'go', to: 'ghost' }],
      }),
    DefinitionError
  );
});

// ── domain: instance transitions ───────────────────────────────────────────────

test('instance: deterministic transitions, history, and status', () => {
  const clock = makeClock(1000);
  const i = createInstance({ definitionName: 'trip', state: 'requested', context: {} }, { clock });
  i.transitionTo('accepted', 'accept', { driver: 'd1' }, 1001);
  assert.equal(i.state, 'accepted');
  assert.equal(i.context.driver, 'd1');
  assert.equal(i.history.length, 1);
  assert.equal(i.version, 2);
  i.complete(1002);
  assert.equal(i.status, 'completed');
});

// ── engine: happy path + persistence + events ──────────────────────────────────

test('workflow: start → accept → finish; persisted; lifecycle events via port', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const { engine } = makePlatform(clock, pub);
  engine.register(tripDef());
  const started = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  assert.equal(started.state, 'requested');
  const accepted = await engine.signal({
    workflowId: started.workflowId,
    event: 'accept',
    payload: { driver: 'd9' },
  });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.context.driver, 'd9'); // action applied
  const done = await engine.signal({ workflowId: started.workflowId, event: 'finish' });
  assert.equal(done.state, 'completed');
  assert.equal(done.status, 'completed');
  // Persisted in the Storage kernel.
  const persisted = await engine.get(started.workflowId);
  assert.equal(persisted.status, 'completed');
  const wfTypes = pub.events.filter((e) => e.producer === 'workflow').map((e) => e.type);
  assert.ok(wfTypes.includes('WorkflowStarted'));
  assert.ok(wfTypes.includes('WorkflowTransitioned'));
  assert.ok(wfTypes.includes('WorkflowCompleted'));
  // Integration: the other kernels participated.
  assert.ok(pub.events.some((e) => e.producer === 'storage'));
  assert.ok(pub.events.some((e) => e.producer === 'lock'));
});

// ── guard + invalid transition ──────────────────────────────────────────────────

test('workflow: guard rejection and unknown transition are typed errors', async () => {
  const clock = makeClock(1000);
  const { engine } = makePlatform(clock, recordingPublisher());
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: {} }); // no rider → guard fails
  await assert.rejects(
    () => engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd1' } }),
    GuardRejectedError
  );
  await assert.rejects(
    () => engine.signal({ workflowId: w.workflowId, event: 'nope' }),
    TransitionError
  );
});

// ── timeout via Scheduler kernel ────────────────────────────────────────────────

test('workflow: per-state timeout fires via the Scheduler → failure terminal', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const { engine, sc } = makePlatform(clock, pub);
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  assert.equal(w.state, 'requested');
  clock.set(6001); // past the 5000ms timeout
  await sc.scheduler.tick(6001); // Scheduler drives the timeout handler
  const after = await engine.get(w.workflowId);
  assert.equal(after.state, 'expired');
  assert.equal(after.status, 'failed');
  assert.ok(pub.events.some((e) => e.type === 'WorkflowTimedOut'));
  assert.ok(pub.events.some((e) => e.type === 'WorkflowFailed'));
});

test('workflow: a real transition cancels the pending timeout (no false expiry)', async () => {
  const clock = makeClock(1000);
  const { engine, sc } = makePlatform(clock, recordingPublisher());
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  await engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'd1' } });
  clock.set(9000);
  await sc.scheduler.tick(9000); // the requested-state timer must have been cancelled
  const after = await engine.get(w.workflowId);
  assert.equal(after.state, 'accepted'); // not expired
});

// ── lock-guarded concurrency ────────────────────────────────────────────────────

test('workflow: concurrent signals serialize; exactly one transition wins', async () => {
  const clock = makeClock(1000);
  const { engine } = makePlatform(clock, recordingPublisher());
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  // Fire the same event twice concurrently: one transitions, the other finds the
  // state already advanced and fails with TransitionError (no double transition).
  const results = await Promise.allSettled([
    engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'a' } }),
    engine.signal({ workflowId: w.workflowId, event: 'accept', payload: { driver: 'b' } }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  const after = await engine.get(w.workflowId);
  assert.equal(after.state, 'accepted');
  assert.equal(after.version, 2); // exactly one transition applied
});

// ── cancel ──────────────────────────────────────────────────────────────────────

test('workflow: cancel stops the workflow and cancels timers', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const { engine, sc } = makePlatform(clock, pub);
  engine.register(tripDef());
  const w = await engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  await engine.cancel(w.workflowId);
  assert.equal((await engine.get(w.workflowId)).status, 'cancelled');
  clock.set(9000);
  await sc.scheduler.tick(9000); // timer was cancelled → no state change
  assert.equal((await engine.get(w.workflowId)).state, 'requested');
  assert.ok(pub.events.some((e) => e.type === 'WorkflowCancelled'));
  // Signalling a cancelled workflow is rejected.
  await assert.rejects(
    () => engine.signal({ workflowId: w.workflowId, event: 'accept' }),
    InvalidStateError
  );
});

// ── works without optional kernels (storage only) ──────────────────────────────

test('workflow: functions with Storage only (lock/scheduler optional)', async () => {
  const clock = makeClock(1000);
  const st = createStoragePlatform({ clock });
  const wf = createWorkflowPlatform({ storage: st.storage, clock });
  wf.engine.register(tripDef());
  const w = await wf.engine.start({ definitionName: 'trip', input: { rider: 'r1' } });
  const a = await wf.engine.signal({
    workflowId: w.workflowId,
    event: 'accept',
    payload: { driver: 'd1' },
  });
  assert.equal(a.state, 'accepted');
  const h = await wf.engine.health();
  assert.equal(h.wiring.storage, true);
  assert.equal(h.wiring.lock, false);
});

// ── SDK adapter: ownership + capability enforcement ─────────────────────────────

test('workflow SDK adapter: ownership isolation + capability gates', async () => {
  const clock = makeClock(1000);
  const { engine } = makePlatform(clock, recordingPublisher());
  const portA = toWorkflowPort(engine, { owner: 'ext-a' });
  const portB = toWorkflowPort(engine, { owner: 'ext-b' });
  portA.register(tripDef());
  portB.register(tripDef());
  const wa = await portA.start({ definitionName: 'trip', input: { rider: 'r1' } });
  // B cannot see or signal A's workflow.
  assert.equal(await portB.get(wa.workflowId), null);
  await assert.rejects(
    () => portB.signal({ workflowId: wa.workflowId, event: 'accept' }),
    /does not own/
  );
  // A sees only its own.
  assert.equal((await portA.list()).length, 1);
  const readonly = toWorkflowPort(engine, { owner: 'ext-c', canWrite: false });
  await assert.rejects(async () => readonly.start({ definitionName: 'trip' }), /workflow:write/);
});

// ── stress ───────────────────────────────────────────────────────────────────────

test('workflow: stress — 300 workflows started + driven to completion', async () => {
  const clock = makeClock(1000);
  const { engine } = makePlatform(clock, recordingPublisher());
  engine.register(tripDef());
  const ids = [];
  for (let i = 0; i < 300; i++) {
    const w = await engine.start({ definitionName: 'trip', input: { rider: 'r' + i } });
    ids.push(w.workflowId);
  }
  for (const id of ids) {
    await engine.signal({ workflowId: id, event: 'accept', payload: { driver: 'd' } });
    await engine.signal({ workflowId: id, event: 'finish' });
  }
  const m = engine.metrics();
  assert.equal(m.started, 300);
  assert.equal(m.completed, 300);
  assert.equal(m.active, 0);
});
