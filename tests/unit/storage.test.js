'use strict';

/**
 * Enterprise Storage tests (Phase 14.3.4) — covers every required category:
 * unit (record, query, cache, metrics), provider (memory + file + extension
 * points), transaction (commit/rollback/nested guard), concurrency (optimistic
 * locking + serialized writes), stress, performance, and failure injection,
 * plus events-via-port, namespaces/TTL/binary, and the SDK namespace-isolated
 * adapter. Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const record = require('../../src/domain/storage/record');
const query = require('../../src/domain/storage/query');
const { createStorageCache } = require('../../src/application/storage/cache');
const { createStorageMetrics } = require('../../src/application/storage/metrics');
const { createStoragePlatform, providers } = require('../../src/application/storage');
const { toStoragePort } = require('../../src/application/storage/sdkAdapter');
const {
  ConcurrencyError,
  NotFoundError,
  TransactionError,
} = require('../../src/domain/storage/errors');

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

// ── domain unit: record + query ────────────────────────────────────────────────

test('record: versioning, TTL expiry, content-type inference', () => {
  const clock = makeClock(1000);
  const r = record.createRecord({ namespace: 'n', key: 'k', value: { a: 1 } }, { clock });
  assert.equal(r.version, 1);
  assert.equal(r.contentType, 'application/json');
  const r2 = record.bumpVersion(r, { value: { a: 2 } }, { clock });
  assert.equal(r2.version, 2);
  const bin = record.createRecord({ namespace: 'n', key: 'b', value: Buffer.from('x') }, { clock });
  assert.equal(bin.contentType, 'application/octet-stream');
  const ttl = record.createRecord({ namespace: 'n', key: 't', value: 1, ttlMs: 50 }, { clock });
  assert.ok(!record.isExpired(ttl, 1049));
  assert.ok(record.isExpired(ttl, 1051));
});

test('query: filter operators + sort + pagination are deterministic', () => {
  const recs = [1, 2, 3, 4, 5].map((n) => ({
    key: 'k' + n,
    collection: 'c',
    value: { n },
    metadata: {},
  }));
  assert.deepEqual(
    query
      .evaluate(recs, { where: { n: { op: 'gte', value: 3 } }, sort: { field: 'n', dir: 'desc' } })
      .map((r) => r.value.n),
    [5, 4, 3]
  );
  assert.deepEqual(
    query.evaluate(recs, { limit: 2, offset: 1 }).map((r) => r.key),
    ['k2', 'k3']
  );
  assert.deepEqual(
    query.evaluate(recs, { where: { n: { op: 'in', value: [2, 4] } } }).map((r) => r.value.n),
    [2, 4]
  );
});

// ── unit: cache + metrics ───────────────────────────────────────────────────────

test('cache: hit/miss + version put + namespace invalidation', () => {
  const c = createStorageCache();
  const ck = c.compositeKey('ns', 'col', 'k');
  assert.equal(c.get(ck), undefined); // miss
  c.put(ck, { version: 1 });
  assert.deepEqual(c.get(ck), { version: 1 }); // hit
  c.invalidateNamespace('ns');
  assert.equal(c.get(ck), undefined);
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
});

test('metrics: counters + prometheus exposition', async () => {
  const m = createStorageMetrics({ clock: () => 0 });
  m.recordRead();
  m.recordWrite();
  m.recordUpdate();
  m.recordDelete();
  m.recordTransaction();
  m.recordCache(true);
  m.recordCache(false);
  await m.timeOp(async () => 'x');
  const s = m.snapshot();
  assert.equal(s.reads, 1);
  assert.equal(s.writes, 1);
  assert.equal(s.cacheHitRatio, 0.5);
  assert.match(m.prometheus(), /storage_writes_total 1/);
  assert.match(m.prometheus(), /storage_cache_hit_ratio 0\.5/);
});

// ── providers ────────────────────────────────────────────────────────────────

test('providers: memory round-trips; file persists + restores (incl. binary)', async () => {
  const mem = providers.createMemoryProvider();
  await mem.write('n', 'k', {
    namespace: 'n',
    collection: 'c',
    key: 'k',
    value: { a: 1 },
    metadata: {},
    version: 1,
  });
  assert.equal((await mem.read('n', 'k')).value.a, 1);
  assert.equal(await mem.remove('n', 'k'), true);
  assert.equal(await mem.read('n', 'k'), null);

  // File provider with injected in-memory "disk".
  let disk = null;
  const file = providers.createFileProvider({
    path: 'store.json',
    readFile: () => disk,
    writeFile: (_p, text) => (disk = text),
  });
  const bin = Buffer.from('hello');
  await file.write('n', 'b', {
    namespace: 'n',
    collection: 'c',
    key: 'b',
    value: bin,
    metadata: {},
    version: 1,
  });
  const back = await file.read('n', 'b');
  assert.ok(Buffer.isBuffer(back.value));
  assert.equal(back.value.toString(), 'hello');
  assert.ok(disk.includes('__binary_base64__')); // persisted as base64
});

test('providers: future providers are declared, not implemented', async () => {
  assert.ok(providers.FUTURE_PROVIDERS.includes('postgres'));
  const p = providers.futureProvider('s3');
  assert.equal(p.planned, true);
  await assert.rejects(() => p.read('n', 'k'), /extension point/);
});

// ── service: CRUD + events + namespaces ────────────────────────────────────────

test('storage: put/get/update/delete with events + namespace isolation', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const st = createStoragePlatform({ clock, publisher: pub });
  const s = st.storage;
  await s.put({ namespace: 'a', key: 'k', value: { n: 1 } });
  await s.put({ namespace: 'b', key: 'k', value: { n: 99 } }); // different namespace
  assert.equal((await s.get({ namespace: 'a', key: 'k' })).value.n, 1);
  assert.equal((await s.get({ namespace: 'b', key: 'k' })).value.n, 99); // isolated
  await s.update({ namespace: 'a', key: 'k', value: { n: 2 } });
  assert.equal((await s.get({ namespace: 'a', key: 'k' })).version, 2);
  assert.equal(await s.delete({ namespace: 'a', key: 'k' }), true);
  assert.equal(await s.get({ namespace: 'a', key: 'k' }), null);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('StorageCreated') &&
      types.includes('StorageUpdated') &&
      types.includes('StorageDeleted')
  );
  assert.ok(pub.events.every((e) => e.producer === 'storage'));
});

test('storage: update on missing key throws NotFound', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  await assert.rejects(
    () => st.storage.update({ namespace: 'n', key: 'ghost', value: 1 }),
    NotFoundError
  );
});

// ── optimistic concurrency ──────────────────────────────────────────────────────

test('storage: optimistic locking detects version conflict', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  const s = st.storage;
  await s.put({ namespace: 'n', key: 'k', value: { n: 1 } }); // v1
  await s.update({ namespace: 'n', key: 'k', value: { n: 2 }, expectedVersion: 1 }); // ok → v2
  await assert.rejects(
    () => s.update({ namespace: 'n', key: 'k', value: { n: 3 }, expectedVersion: 1 }),
    ConcurrencyError
  );
});

// ── transactions ────────────────────────────────────────────────────────────────

test('storage: transaction commits atomically', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const st = createStoragePlatform({ clock, publisher: pub });
  const s = st.storage;
  await s.put({ namespace: 'n', key: 'x', value: { v: 0 } });
  await s.transaction(async (tx) => {
    await tx.put({ namespace: 'n', key: 'y', value: { v: 1 } });
    await tx.update({ namespace: 'n', key: 'x', value: { v: 9 } });
    await tx.delete({ namespace: 'n', key: 'x' });
  });
  assert.equal(await s.exists({ namespace: 'n', key: 'x' }), false); // deleted in tx
  assert.equal((await s.get({ namespace: 'n', key: 'y' })).value.v, 1);
  assert.ok(pub.events.some((e) => e.type === 'TransactionCommitted'));
});

test('storage: transaction rolls back on error (nothing persisted)', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const st = createStoragePlatform({ clock, publisher: pub });
  const s = st.storage;
  await assert.rejects(
    () =>
      s.transaction(async (tx) => {
        await tx.put({ namespace: 'n', key: 'z', value: { v: 1 } });
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(await s.exists({ namespace: 'n', key: 'z' }), false); // rolled back
  assert.ok(pub.events.some((e) => e.type === 'TransactionRolledBack'));
});

test('storage: nested transaction is rejected', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  await assert.rejects(
    () => st.storage.transaction(async (tx) => tx.transaction(async () => {})),
    TransactionError
  );
});

test('storage: batch applies atomically', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  const s = st.storage;
  await s.batch([
    { op: 'put', namespace: 'n', key: 'a', value: 1 },
    { op: 'put', namespace: 'n', key: 'b', value: 2 },
  ]);
  assert.deepEqual(
    (await s.list({ namespace: 'n' })).map((r) => r.key),
    ['a', 'b']
  );
});

// ── concurrency: serialized writes keep versions monotonic ─────────────────────

test('storage: concurrent puts on one key serialize to monotonic versions', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  const s = st.storage;
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => s.put({ namespace: 'n', key: 'k', value: { i } }))
  );
  const rec = await s.get({ namespace: 'n', key: 'k' });
  assert.equal(rec.version, 20); // 1 create + 19 replaces, no lost updates
});

// ── failure injection ──────────────────────────────────────────────────────────

test('storage: a failing provider write surfaces and does not corrupt state', async () => {
  const clock = makeClock();
  const mem = providers.createMemoryProvider();
  let failNext = false;
  const flaky = {
    ...mem,
    name: 'flaky',
    write: (ns, k, r) => (failNext ? Promise.reject(new Error('disk full')) : mem.write(ns, k, r)),
  };
  const st = createStoragePlatform({ clock, provider: flaky, cache: null });
  const s = st.storage;
  await s.put({ namespace: 'n', key: 'k', value: 1 });
  failNext = true;
  await assert.rejects(() => s.put({ namespace: 'n', key: 'k', value: 2 }), /disk full/);
  failNext = false;
  assert.equal((await s.get({ namespace: 'n', key: 'k' })).value, 1); // unchanged
});

// ── SDK adapter: namespace isolation + capability enforcement ──────────────────

test('storage SDK adapter: namespace isolation + capability gates', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  const portA = toStoragePort(st.storage, { owner: 'ext-a' });
  const portB = toStoragePort(st.storage, { owner: 'ext-b' });
  await portA.put({ key: 'k', value: { who: 'a' } });
  await portB.put({ key: 'k', value: { who: 'b' } });
  assert.equal((await portA.get({ key: 'k' })).value.who, 'a'); // isolated
  assert.equal((await portB.get({ key: 'k' })).value.who, 'b');
  assert.equal((await portA.list({})).length, 1); // only own namespace

  const readonly = toStoragePort(st.storage, { owner: 'ext-c', canWrite: false });
  await assert.rejects(async () => readonly.put({ key: 'x', value: 1 }), /storage:write/);
});

// ── stress + performance ───────────────────────────────────────────────────────

test('storage: stress — 2000 keys written, queried, and read back', async () => {
  const st = createStoragePlatform({ clock: makeClock() });
  const s = st.storage;
  const start = Date.now();
  for (let i = 0; i < 2000; i++)
    await s.put({ namespace: 'n', key: 'k' + i, value: { i, even: i % 2 === 0 } });
  const evens = await s.query({ namespace: 'n', where: { even: true } });
  const elapsed = Date.now() - start;
  assert.equal(evens.length, 1000);
  assert.equal((await s.get({ namespace: 'n', key: 'k1999' })).value.i, 1999);
  assert.ok(elapsed < 3000, `too slow: ${elapsed}ms`);
});
