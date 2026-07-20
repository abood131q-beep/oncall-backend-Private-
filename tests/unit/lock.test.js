'use strict';

/**
 * Enterprise Lock tests (Phase 14.3.5) — covers every required category: unit
 * (lock entity + lifecycle, provider, metrics), concurrency, lease, expiration,
 * conflict, stress, and failure injection, plus events-via-port and the SDK
 * owner-scoped adapter (ownership + namespace isolation + capability gates).
 * Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLock, STATE } = require('../../src/domain/lock/lock');
const { createLockPlatform, providers } = require('../../src/application/lock');
const { createLockMetrics } = require('../../src/application/lock/metrics');
const { toLockPort } = require('../../src/application/lock/sdkAdapter');
const { LockConflictError, OwnershipError } = require('../../src/domain/lock/errors');

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

// ── domain: lock entity + deterministic lifecycle ──────────────────────────────

test('lock entity: deterministic acquire → renew → expire → release transitions', () => {
  const clock = makeClock(1000);
  const l = createLock({ lockId: 'k', namespace: 'n', leaseMs: 100 }, { clock });
  assert.equal(l.state, STATE.AVAILABLE);
  l.acquire('o', 1000, 100);
  assert.equal(l.state, STATE.ACQUIRED);
  assert.equal(l.expiresAt, 1100);
  assert.ok(l.isLive(1050));
  l.renew(1050, 100);
  assert.equal(l.expiresAt, 1150);
  assert.equal(l.version, 2);
  assert.ok(!l.isLive(1200));
  assert.equal(l.settleExpiry(1200), true);
  assert.equal(l.state, STATE.EXPIRED);
  l.acquire('o2', 1200, 100);
  l.release();
  assert.equal(l.state, STATE.RELEASED);
  assert.throws(() => createLock({ namespace: 'n' }), /lockId/);
});

// ── provider + future extension points ─────────────────────────────────────────

test('provider: memory round-trips; future providers declared not implemented', async () => {
  const mem = providers.createMemoryProvider();
  await mem.write('n', 'k', {
    lockId: 'k',
    namespace: 'n',
    ownerId: 'o',
    metadata: {},
    version: 1,
  });
  assert.equal((await mem.read('n', 'k')).ownerId, 'o');
  assert.equal((await mem.scan('n')).length, 1);
  assert.equal(await mem.remove('n', 'k'), true);

  assert.ok(providers.FUTURE_PROVIDERS.includes('zookeeper'));
  const p = providers.futureProvider('etcd');
  assert.equal(p.planned, true);
  await assert.rejects(() => p.read('n', 'k'), /extension point/);
});

// ── metrics ──────────────────────────────────────────────────────────────────

test('metrics: counters + prometheus exposition', async () => {
  const m = createLockMetrics({ clock: () => 0 });
  m.recordAcquire();
  m.recordRelease();
  m.recordRenew();
  m.recordExpiration();
  m.recordConflict();
  m.recordHeldDuration(100);
  await m.timeOp(async () => 'x');
  const s = m.snapshot();
  assert.equal(s.acquired, 1);
  assert.equal(s.conflicts, 1);
  assert.equal(s.avgLeaseDurationMs, 100);
  assert.match(m.prometheus(), /lock_acquired_total 1/);
  assert.match(m.prometheus(), /lock_conflicts_total 1/);
});

// ── acquire / conflict / events ────────────────────────────────────────────────

test('lock: tryAcquire grants once; second owner conflicts; events via port', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const lk = createLockPlatform({ clock, publisher: pub });
  const L = lk.lock;
  const a = await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A', leaseMs: 100 });
  assert.equal(a.ownerId, 'A');
  assert.equal(await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'B' }), null); // conflict
  assert.equal(await L.isHeld({ namespace: 'n', lockId: 'k' }), true);
  assert.equal(await L.owner({ namespace: 'n', lockId: 'k' }), 'A');
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('LockAcquired') && types.includes('LockConflict'));
  assert.ok(pub.events.every((e) => e.producer === 'lock'));
});

test('lock: acquire() throws LockConflictError when held by another owner', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  await lk.lock.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A' });
  await assert.rejects(
    () => lk.lock.acquire({ namespace: 'n', lockId: 'k', ownerId: 'B' }),
    LockConflictError
  );
});

test('lock: same owner re-acquire is reentrant (refreshes lease)', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const first = await lk.lock.tryAcquire({
    namespace: 'n',
    lockId: 'k',
    ownerId: 'A',
    leaseMs: 100,
  });
  clock.set(1050);
  const again = await lk.lock.tryAcquire({
    namespace: 'n',
    lockId: 'k',
    ownerId: 'A',
    leaseMs: 100,
  });
  assert.ok(again); // not a conflict for the same owner
  assert.equal(again.expiresAt, 1150); // lease refreshed
  assert.ok(again.version > first.version);
});

// ── lease renewal + ownership ──────────────────────────────────────────────────

test('lock: renew extends lease for the owner; non-owner renew is rejected', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const lk = createLockPlatform({ clock, publisher: pub });
  const L = lk.lock;
  await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A', leaseMs: 100 });
  const r = await L.renew({ namespace: 'n', lockId: 'k', ownerId: 'A', leaseMs: 500 });
  assert.equal(r.expiresAt, 1500);
  await assert.rejects(
    () => L.renew({ namespace: 'n', lockId: 'k', ownerId: 'B', leaseMs: 100 }),
    OwnershipError
  );
  assert.ok(pub.events.some((e) => e.type === 'LockRenewed'));
});

// ── expiration ───────────────────────────────────────────────────────────────

test('lock: lease auto-expires; another owner can then acquire; LockExpired emitted', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const lk = createLockPlatform({ clock, publisher: pub });
  const L = lk.lock;
  await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A', leaseMs: 100 });
  clock.set(1101); // past expiry
  assert.equal(await L.isHeld({ namespace: 'n', lockId: 'k' }), false);
  assert.equal(await L.owner({ namespace: 'n', lockId: 'k' }), null);
  const b = await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'B' });
  assert.equal(b.ownerId, 'B');
  assert.ok(pub.events.some((e) => e.type === 'LockExpired'));
});

// ── renew after expiry fails ────────────────────────────────────────────────────

test('lock: renew after expiry is rejected (lease no longer live)', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  await lk.lock.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A', leaseMs: 100 });
  clock.set(1200);
  await assert.rejects(
    () => lk.lock.renew({ namespace: 'n', lockId: 'k', ownerId: 'A' }),
    OwnershipError
  );
});

// ── release ─────────────────────────────────────────────────────────────────

test('lock: release frees the lock; releasing a free lock is idempotent', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const L = lk.lock;
  await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A' });
  assert.equal(await L.release({ namespace: 'n', lockId: 'k', ownerId: 'A' }), true);
  assert.equal(await L.isHeld({ namespace: 'n', lockId: 'k' }), false);
  assert.equal(await L.release({ namespace: 'n', lockId: 'k', ownerId: 'A' }), false); // already free
});

// ── concurrency: mutual exclusion under a race ─────────────────────────────────

test('lock: concurrent acquisitions grant to exactly one owner', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const L = lk.lock;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'owner-' + i, leaseMs: 1000 })
    )
  );
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1); // exactly one acquired; the rest conflicted
});

// ── namespace isolation ──────────────────────────────────────────────────────

test('lock: same lockId in different namespaces is independent', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const L = lk.lock;
  const a = await L.tryAcquire({ namespace: 'ns1', lockId: 'k', ownerId: 'A' });
  const b = await L.tryAcquire({ namespace: 'ns2', lockId: 'k', ownerId: 'B' });
  assert.ok(a && b); // no conflict across namespaces
  assert.equal(await L.owner({ namespace: 'ns1', lockId: 'k' }), 'A');
  assert.equal(await L.owner({ namespace: 'ns2', lockId: 'k' }), 'B');
});

// ── SDK adapter: ownership + namespace isolation + capability gates ────────────

test('lock SDK adapter: forces owner + namespace; capability enforcement', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const portA = toLockPort(lk.lock, { owner: 'ext-a' });
  const portB = toLockPort(lk.lock, { owner: 'ext-b' });
  // Same lockId, different extensions → isolated namespaces, both succeed.
  assert.ok(await portA.tryAcquire({ lockId: 'k' }));
  assert.ok(await portB.tryAcquire({ lockId: 'k' }));
  assert.equal(await portA.owner({ lockId: 'k' }), 'ext-a'); // owner forced to ext id
  // A cannot acquire under a spoofed owner id — the adapter overrides it.
  const spoof = await portA.tryAcquire({ lockId: 'k', ownerId: 'someone-else' });
  assert.ok(spoof); // reentrant for ext-a (owner was forced back to ext-a)
  assert.equal(spoof.ownerId, 'ext-a');

  const readonly = toLockPort(lk.lock, { owner: 'ext-c', canWrite: false });
  await assert.rejects(async () => readonly.tryAcquire({ lockId: 'x' }), /lock:write/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('lock: a failing provider write surfaces and does not corrupt state', async () => {
  const clock = makeClock(1000);
  const mem = providers.createMemoryProvider();
  let failNext = false;
  const flaky = {
    ...mem,
    name: 'flaky',
    write: (ns, k, m) =>
      failNext ? Promise.reject(new Error('backend down')) : mem.write(ns, k, m),
  };
  const lk = createLockPlatform({ clock, provider: flaky });
  const L = lk.lock;
  await L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A' });
  failNext = true;
  await assert.rejects(
    () => L.tryAcquire({ namespace: 'n', lockId: 'k', ownerId: 'A' }),
    /backend down/
  );
  failNext = false;
  assert.equal(await L.owner({ namespace: 'n', lockId: 'k' }), 'A'); // unchanged
});

// ── stress ─────────────────────────────────────────────────────────────────────

test('lock: stress — 1000 distinct locks acquired + released', async () => {
  const clock = makeClock(1000);
  const lk = createLockPlatform({ clock });
  const L = lk.lock;
  for (let i = 0; i < 1000; i++) {
    await L.tryAcquire({ namespace: 'n', lockId: 'k' + i, ownerId: 'svc', leaseMs: 1000 });
  }
  assert.equal(await L.isHeld({ namespace: 'n', lockId: 'k999' }), true);
  for (let i = 0; i < 1000; i++) {
    await L.release({ namespace: 'n', lockId: 'k' + i, ownerId: 'svc' });
  }
  assert.equal(lk.lock.metrics().acquired, 1000);
  assert.equal(lk.lock.metrics().released, 1000);
});
