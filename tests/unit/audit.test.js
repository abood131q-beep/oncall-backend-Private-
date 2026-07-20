'use strict';

/**
 * Enterprise Audit tests (Phase 14.7 / ADR-026) — covers every required category:
 * unit (record, query), integrity (checksum + hash-chain + tamper detection),
 * query, correlation/timeline, stress, and failure injection, plus events-via-
 * port, immutability, and the SDK owner-scoped adapter (namespace isolation +
 * capability gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecord, verifyChecksum, GENESIS } = require('../../src/domain/audit/record');
const auditQuery = require('../../src/domain/audit/query');
const { createAuditPlatform, providers } = require('../../src/application/audit');
const { createAuditMetrics } = require('../../src/application/audit/metrics');
const { toAuditPort } = require('../../src/application/audit/sdkAdapter');
const { AuditValidationError } = require('../../src/domain/audit/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  clock.tick = (d = 1) => (box.now += d);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}

// ── domain: record ─────────────────────────────────────────────────────────────

test('record: immutable, checksummed, chained; validation', () => {
  const clock = makeClock(1000);
  const r0 = createRecord(
    { action: 'a', actor: 'u1' },
    { sequence: 0, prevChecksum: GENESIS },
    { clock }
  );
  assert.ok(Object.isFrozen(r0));
  assert.ok(Object.isFrozen(r0.metadata));
  assert.equal(r0.checksum.length, 64);
  assert.equal(r0.prevChecksum, GENESIS);
  assert.throws(() => {
    r0.action = 'b';
  }, TypeError);
  const r1 = createRecord({ action: 'b' }, { sequence: 1, prevChecksum: r0.checksum }, { clock });
  assert.equal(r1.prevChecksum, r0.checksum);
  assert.ok(verifyChecksum(r0));
  assert.ok(!verifyChecksum({ ...r0, action: 'tampered' }));
  assert.throws(() => createRecord({}, {}), AuditValidationError);
});

// ── domain: query ──────────────────────────────────────────────────────────────

test('query: filter by fields/time-range/metadata + sort + pagination', () => {
  const clock = makeClock(1000);
  const recs = [];
  for (let i = 0; i < 5; i++) {
    recs.push(
      createRecord(
        { action: 'act', actor: i % 2 ? 'a' : 'b', correlationId: 'c', metadata: { n: i } },
        { sequence: i, prevChecksum: GENESIS },
        { clock: () => 1000 + i }
      )
    );
  }
  assert.equal(auditQuery.evaluate(recs, { filter: { actor: 'a' } }).length, 2);
  assert.equal(auditQuery.evaluate(recs, { filter: { from: 1002, to: 1003 } }).length, 2);
  assert.equal(auditQuery.evaluate(recs, { filter: { 'metadata.n': 4 } }).length, 1);
  assert.equal(auditQuery.evaluate(recs, { sort: 'desc' })[0].sequence, 4);
  assert.deepEqual(
    auditQuery.evaluate(recs, { limit: 2, offset: 1 }).map((r) => r.sequence),
    [1, 2]
  );
});

// ── unit: metrics ──────────────────────────────────────────────────────────────

test('metrics: counters + prometheus', () => {
  const m = createAuditMetrics({ clock: () => 0 });
  m.recordWritten();
  m.recordQuery();
  m.recordVerification(false);
  m.recordChecksumFailure();
  const s = m.snapshot();
  assert.equal(s.written, 1);
  assert.equal(s.verificationFailures, 1);
  assert.equal(s.checksumFailures, 1);
  assert.match(m.prometheus(), /audit_records_written_total 1/);
  assert.match(m.prometheus(), /audit_checksum_failures_total 1/);
});

// ── provider + future extension points ─────────────────────────────────────────

test('provider: memory is append-only; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  const clock = makeClock();
  const r = createRecord({ action: 'a' }, { sequence: 0, prevChecksum: GENESIS }, { clock });
  await mem.append('n', r);
  assert.equal(mem.count('n'), 1);
  assert.equal((await mem.get('n', r.auditId)).action, 'a');
  assert.equal(mem.tail('n').auditId, r.auditId);
  assert.equal(typeof mem.append, 'function');
  assert.equal(typeof mem.get, 'function'); // no update/delete surface
  assert.ok(providers.FUTURE_PROVIDERS.includes('postgres'));
  const p = providers.futureProvider('mongodb');
  assert.equal(p.planned, true);
  assert.throws(() => p.append('n', {}), /extension point/);
});

// ── service: record + events + immutability ─────────────────────────────────────

test('audit: record appends immutable, chained entries + events via port', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const A = createAuditPlatform({ clock, publisher: pub });
  const r0 = await A.audit.record({ action: 'trip.created', actor: 'u1', correlationId: 'c1' });
  clock.tick();
  const r1 = await A.audit.record({ action: 'trip.accepted', actor: 'd1', correlationId: 'c1' });
  assert.equal(r0.sequence, 0);
  assert.equal(r1.sequence, 1);
  assert.equal(r1.prevChecksum, r0.checksum); // hash chain
  assert.ok(Object.isFrozen(r0));
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('AuditRecorded'));
  assert.ok(pub.events.every((e) => e.producer === 'audit'));
  // The recorded event carries a summary, not full metadata.
  const recorded = pub.events.find((e) => e.type === 'AuditRecorded');
  assert.equal(recorded.payload.action, 'trip.created');
});

test('audit: record requires an action', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  await assert.rejects(async () => A.audit.record({ actor: 'u1' }), AuditValidationError);
});

// ── integrity: verify a clean chain, then detect tampering ──────────────────────

test('audit: verify passes on a clean chain', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const A = createAuditPlatform({ clock, publisher: pub });
  for (let i = 0; i < 5; i++) {
    await A.audit.record({ action: 'act' + i, correlationId: 'c' });
    clock.tick();
  }
  const v = await A.audit.verify();
  assert.equal(v.ok, true);
  assert.equal(v.checked, 5);
  assert.ok(pub.events.some((e) => e.type === 'AuditVerified'));
});

test('audit: verify detects a tampered record (checksum) + chain break', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  // A tamperable provider that lets the test mutate stored records post-append.
  const store = [];
  const provider = {
    name: 'tamperable',
    append: (ns, r) => (store.push(r), Promise.resolve()),
    scan: () => Promise.resolve(store.slice()),
    get: (ns, id) => Promise.resolve(store.find((r) => r.auditId === id) || null),
    count: () => store.length,
    tail: () => (store.length ? store[store.length - 1] : null),
    health: () => ({ ok: true }),
  };
  const A = createAuditPlatform({ clock, publisher: pub, provider });
  await A.audit.record({ action: 'a' });
  clock.tick();
  await A.audit.record({ action: 'b' });
  assert.equal((await A.audit.verify()).ok, true);
  // Tamper: overwrite a stored record's checksum. Its content no longer matches
  // the checksum (mismatch) AND the next record's prevChecksum no longer links
  // to it (chain break) — both forensic signals fire.
  store[0] = { ...store[0], checksum: 'deadbeef'.padEnd(64, '0') };
  const v = await A.audit.verify();
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'checksum mismatch'));
  assert.ok(v.issues.some((i) => i.reason === 'chain break'));
  assert.ok(pub.events.some((e) => e.type === 'AuditIntegrityFailure'));
  assert.ok(A.audit.metrics().checksumFailures >= 1);
});

// ── correlation / timeline reconstruction ──────────────────────────────────────

test('audit: timeline reconstruction by correlation id', async () => {
  const clock = makeClock(1000);
  const A = createAuditPlatform({ clock });
  await A.audit.record({ action: 'requested', correlationId: 'trip-1', workflowId: 'wf-1' });
  clock.tick();
  await A.audit.record({ action: 'accepted', correlationId: 'trip-1', workflowId: 'wf-1' });
  clock.tick();
  await A.audit.record({ action: 'other', correlationId: 'trip-2' });
  clock.tick();
  await A.audit.record({ action: 'completed', correlationId: 'trip-1', workflowId: 'wf-1' });
  const timeline = await A.audit.query({ filter: { correlationId: 'trip-1' } });
  assert.deepEqual(
    timeline.map((r) => r.action),
    ['requested', 'accepted', 'completed']
  ); // append order
  assert.equal((await A.audit.query({ filter: { workflowId: 'wf-1' } })).length, 3);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('audit: a provider append failure surfaces + increments providerFailures', async () => {
  const clock = makeClock();
  const mem = providers.createMemoryProvider();
  let failAppend = false;
  const flaky = {
    ...mem,
    append: (ns, r) => (failAppend ? Promise.reject(new Error('store down')) : mem.append(ns, r)),
  };
  const A = createAuditPlatform({ clock, provider: flaky });
  await A.audit.record({ action: 'ok' });
  failAppend = true;
  await assert.rejects(() => A.audit.record({ action: 'fails' }), /store down/);
  assert.ok(A.audit.metrics().providerFailures >= 1);
  failAppend = false;
  // The failed record was never appended → chain stays intact.
  assert.equal((await A.audit.verify()).ok, true);
});

// ── SDK adapter: namespace isolation + capability gates ─────────────────────────

test('audit SDK adapter: namespace isolation + capability enforcement', async () => {
  const clock = makeClock();
  const A = createAuditPlatform({ clock });
  const portA = toAuditPort(A.audit, { owner: 'ext-a' });
  const portB = toAuditPort(A.audit, { owner: 'ext-b' });
  await portA.record({ action: 'a-event' });
  await portB.record({ action: 'b-event' });
  assert.equal((await portA.query({})).length, 1); // isolated
  assert.equal((await portA.query({}))[0].actor, 'ext-a'); // actor defaulted to owner
  assert.equal((await portB.query({})).length, 1);
  assert.equal((await portA.verify()).ok, true);

  const readonly = toAuditPort(A.audit, { owner: 'ext-c', canWrite: false });
  await assert.rejects(async () => readonly.record({ action: 'x' }), /audit:write/);
});

// ── stress ───────────────────────────────────────────────────────────────────

test('audit: stress — 2000 records append + verify as one intact chain', async () => {
  const clock = makeClock(1000);
  const A = createAuditPlatform({ clock });
  for (let i = 0; i < 2000; i++) {
    await A.audit.record({ action: 'evt', correlationId: 'c' + (i % 10), metadata: { i } });
    clock.tick();
  }
  const v = await A.audit.verify();
  assert.equal(v.ok, true);
  assert.equal(v.checked, 2000);
  assert.equal((await A.audit.query({ filter: { correlationId: 'c3' } })).length, 200);
  assert.equal(A.audit.metrics().written, 2000);
});
