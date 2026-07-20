'use strict';

/**
 * Enterprise Secrets Kernel tests (Phase 14.9 / ADR-028) — covers every required
 * category: unit (secret value object, rotation policy, redaction, metrics),
 * rotation, integrity, provider (+ future extension points), stress, and failure
 * injection, plus versioned resolution, events-via-port (no value leak), and the
 * SDK owner-scoped adapter (namespace isolation + capability gates). Deterministic:
 * clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecret, fromModel, valueChecksum } = require('../../src/domain/secrets/secret');
const { createRotationPolicy } = require('../../src/domain/secrets/rotationPolicy');
const { redactValue, redactModel, REDACTED } = require('../../src/domain/secrets/redaction');
const { createSecretsPlatform, providers } = require('../../src/application/secrets');
const { createSecretsMetrics } = require('../../src/application/secrets/metrics');
const { toSecretsPort } = require('../../src/application/secrets/sdkAdapter');
const {
  SecretValidationError,
  SecretNotFoundError,
  RotationError,
  IntegrityError,
} = require('../../src/domain/secrets/errors');

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

// ── domain: secret value object + integrity + redaction ─────────────────────────

test('secret: create, integrity, redaction, versioned rotate', () => {
  const clock = makeClock(1000);
  const s = createSecret({ name: 'db.pw', value: 'v1', tags: ['db'] }, { clock });
  assert.equal(s.version, 1);
  assert.equal(s.value, 'v1');
  assert.equal(s.valueChecksum, valueChecksum('v1'));
  assert.ok(s.verifyIntegrity());
  assert.equal(s.reveal(), 'v1');
  // public view redacts the value but keeps the fingerprint.
  const pub = s.toPublic();
  assert.equal(pub.value, REDACTED);
  assert.equal(pub.valueChecksum, valueChecksum('v1'));
  // rotate bumps version + updates value/checksum/updatedAt.
  clock.set(2000);
  s.rotate('v2', clock());
  assert.equal(s.version, 2);
  assert.equal(s.value, 'v2');
  assert.equal(s.updatedAt, 2000);
  assert.ok(s.verifyIntegrity());
  assert.throws(() => createSecret({ name: 'x' }), SecretValidationError); // no value
  assert.throws(() => createSecret({ value: 'y' }), SecretValidationError); // no name
});

test('secret: integrity fails when the value is tampered under the checksum', () => {
  const clock = makeClock();
  const s = createSecret({ name: 'k', value: 'good' }, { clock });
  const model = s.toModel();
  model.value = 'tampered'; // checksum still reflects "good"
  const rehydrated = fromModel(model, { clock });
  assert.equal(rehydrated.verifyIntegrity(), false);
});

test('rotationPolicy: validation + isDue', () => {
  assert.throws(() => createRotationPolicy({ intervalMs: -1 }), SecretValidationError);
  const p = createRotationPolicy({ enabled: true, intervalMs: 100, maxVersions: 3 });
  assert.equal(p.isDue(1000, 1050), false);
  assert.equal(p.isDue(1000, 1100), true);
  assert.equal(createRotationPolicy({ enabled: false, intervalMs: 100 }).isDue(0, 1e9), false);
  assert.ok(Object.isFrozen(p));
});

test('redaction: constant token, no length/content leak', () => {
  assert.equal(redactValue('anything-long-or-short'), REDACTED);
  assert.equal(redactValue(null), null);
  const r = redactModel({ name: 'n', value: 'secret', valueChecksum: 'abc' });
  assert.equal(r.value, REDACTED);
  assert.equal(r.valueChecksum, 'abc');
});

// ── unit: metrics ────────────────────────────────────────────────────────────────

test('metrics: counters + gauge + prometheus', () => {
  const m = createSecretsMetrics({ clock: () => 0 });
  m.bindGauges({ storedSecrets: () => 4 });
  m.recordStored();
  m.recordRotation();
  m.recordResolution();
  m.recordRotationLatency(5);
  const s = m.snapshot();
  assert.equal(s.stored, 1);
  assert.equal(s.rotations, 1);
  assert.equal(s.resolutions, 1);
  assert.equal(s.storedSecrets, 4);
  assert.equal(s.lastRotationLatencyMs, 5);
  assert.match(m.prometheus(), /secrets_rotations_total 1/);
  assert.match(m.prometheus(), /secrets_stored_secrets 4/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores current + versions; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putSecret('n', { secretId: 'a', name: 'k', version: 1, value: 'v1', state: 'active' });
  await mem.putSecret('n', { secretId: 'a', name: 'k', version: 2, value: 'v2', state: 'active' });
  assert.equal((await mem.getSecret('n', 'k')).version, 2);
  assert.equal((await mem.getSecretVersion('n', 'k', 1)).value, 'v1');
  assert.deepEqual(await mem.listVersions('n', 'k'), [1, 2]);
  assert.equal((await mem.listSecrets('n')).length, 1);
  assert.equal(await mem.removeSecret('n', 'k'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('vault'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('aws-secrets-manager'));
  const p = providers.futureProvider('azure-key-vault');
  assert.equal(p.planned, true);
  assert.throws(() => p.putSecret('n', {}), /extension point/);
});

// ── store / resolve / list ────────────────────────────────────────────────────────

test('secrets: store + resolve + list; events carry no value', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const sk = createSecretsPlatform({ clock, publisher: pub });
  const S = sk.secrets;
  const stored = await S.store({ name: 'db.password', value: 's3cr3t', tags: ['db'] });
  assert.equal(stored.value, REDACTED); // store never returns plaintext
  assert.equal(stored.version, 1);
  const resolved = await S.resolve({ name: 'db.password' });
  assert.equal(resolved.value, 's3cr3t'); // resolve is the only value-revealing call
  assert.equal(resolved.version, 1);
  const listed = await S.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].value, REDACTED);
  // events: type set present, producer 'secrets', NO value anywhere.
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('SecretStored') && types.includes('SecretResolved'));
  assert.ok(pub.events.every((e) => e.producer === 'secrets'));
  assert.ok(pub.events.every((e) => !('value' in e.payload)));
});

test('secrets: duplicate store rejected; resolve of missing rejects', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'v' });
  await assert.rejects(() => S.store({ name: 'k', value: 'v2' }), SecretValidationError);
  await assert.rejects(() => S.resolve({ name: 'ghost' }), SecretNotFoundError);
  await assert.rejects(() => S.store({ value: 'no-name' }), SecretValidationError);
});

// ── rotation ────────────────────────────────────────────────────────────────────

test('secrets: rotate creates a new version; old versions remain resolvable', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const sk = createSecretsPlatform({ clock, publisher: pub });
  const S = sk.secrets;
  await S.store({ name: 'api.key', value: 'k1' });
  clock.set(2000);
  const rotated = await S.rotate({ name: 'api.key', value: 'k2' });
  assert.equal(rotated.version, 2);
  assert.equal(rotated.value, REDACTED);
  assert.equal((await S.resolve({ name: 'api.key' })).value, 'k2'); // current
  assert.equal((await S.resolve({ name: 'api.key', version: 1 })).value, 'k1'); // history
  assert.equal((await S.resolve({ name: 'api.key', version: 2 })).value, 'k2');
  assert.ok(pub.events.some((e) => e.type === 'SecretRotated'));
  assert.equal(sk.metrics.snapshot().rotations, 1);
});

test('secrets: rotation validation — missing value, unchanged value, unknown secret', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'same' });
  await assert.rejects(() => S.rotate({ name: 'k' }), RotationError); // no value + no factory
  await assert.rejects(() => S.rotate({ name: 'k', value: 'same' }), RotationError); // no-op
  await assert.rejects(() => S.rotate({ name: 'ghost', value: 'x' }), SecretNotFoundError);
});

test('secrets: rotate uses an injected valueFactory when no value is supplied', async () => {
  const clock = makeClock();
  let n = 0;
  const sk = createSecretsPlatform({ clock, valueFactory: () => `gen-${++n}` });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'orig' });
  const r = await S.rotate({ name: 'k' });
  assert.equal(r.version, 2);
  assert.equal((await S.resolve({ name: 'k' })).value, 'gen-1');
});

// ── integrity ────────────────────────────────────────────────────────────────────

test('secrets: resolve rejects a tampered value; verifyIntegrity flags it', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const sk = createSecretsPlatform({ clock, provider });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'good' });
  // Tamper directly in the provider, leaving the old checksum in place.
  const stored = await provider.getSecret('default', 'k');
  await provider.putSecret('default', { ...stored, value: 'evil' });
  await assert.rejects(() => S.resolve({ name: 'k' }), IntegrityError);
  const v = await S.verifyIntegrity('default');
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.name === 'k'));
  assert.ok(sk.metrics.snapshot().integrityFailures >= 1);
});

// ── delete ────────────────────────────────────────────────────────────────────────

test('secrets: delete removes the secret and is idempotent', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const sk = createSecretsPlatform({ clock, publisher: pub });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'v' });
  assert.equal(await S.delete({ name: 'k' }), true);
  assert.equal(await S.delete({ name: 'k' }), false); // already gone
  await assert.rejects(() => S.resolve({ name: 'k' }), SecretNotFoundError);
  assert.ok(pub.events.some((e) => e.type === 'SecretDeleted'));
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates capabilities', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const alice = toSecretsPort(sk.secrets, { owner: 'alice' });
  const bob = toSecretsPort(sk.secrets, { owner: 'bob' });
  await alice.store({ name: 'k', value: 'alice-secret' });
  await bob.store({ name: 'k', value: 'bob-secret' }); // same name, different namespace
  assert.equal((await alice.resolve({ name: 'k' })).value, 'alice-secret');
  assert.equal((await bob.resolve({ name: 'k' })).value, 'bob-secret');
  assert.equal((await alice.list()).length, 1); // only alice's namespace
  // capability gates
  const readOnly = toSecretsPort(sk.secrets, { owner: 'ro', canWrite: false });
  await assert.rejects(async () => readOnly.store({ name: 'x', value: 'y' }), /secrets:write/);
  const writeOnly = toSecretsPort(sk.secrets, { owner: 'wo', canRead: false });
  await writeOnly.store({ name: 'x', value: 'y' });
  await assert.rejects(async () => writeOnly.resolve({ name: 'x' }), /secrets:read/);
  assert.throws(() => toSecretsPort(sk.secrets, {}), /owner required/);
});

// ── verification + diagnostics ────────────────────────────────────────────────────

test('secrets: startup/provider verification + diagnostics + snapshot', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'v' });
  assert.equal(S.verifyStartup().ok, true);
  assert.equal((await S.verifyProvider('default')).ok, true);
  assert.equal((await S.verifyIntegrity('default')).ok, true);
  const snap = await S.snapshotSecret('default', 'k');
  assert.ok(Object.isFrozen(snap));
  assert.equal(snap.value, REDACTED);
  assert.throws(() => {
    snap.name = 'x';
  }, TypeError);
  assert.equal(await S.snapshotSecret('default', 'nope'), null);
  const d = S.diagnostics('default');
  assert.equal(d.secrets, 1);
  assert.ok(d.startup.ok);
  assert.ok(S.history().some((h) => h.type === 'stored'));
});

// ── failure injection ────────────────────────────────────────────────────────────

test('secrets: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putSecret: () => Promise.reject(new Error('disk full')),
    getSecret: () => Promise.resolve(null),
    getSecretVersion: () => Promise.resolve(null),
    listSecrets: () => Promise.resolve([]),
    listVersions: () => Promise.resolve([]),
    removeSecret: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const sk = createSecretsPlatform({ clock, provider: failing });
  await assert.rejects(() => sk.secrets.store({ name: 'k', value: 'v' }), /disk full/);
  assert.ok(sk.metrics.snapshot().providerFailures >= 1);
  assert.equal((await sk.secrets.health()).ok, false);
});

// ── concurrency / stress ──────────────────────────────────────────────────────────

test('secrets: concurrent rotations on one secret serialize (no lost versions)', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const S = sk.secrets;
  await S.store({ name: 'k', value: 'v0' });
  await Promise.all([
    S.rotate({ name: 'k', value: 'a' }),
    S.rotate({ name: 'k', value: 'b' }),
    S.rotate({ name: 'k', value: 'c' }),
  ]);
  assert.equal((await S.resolve({ name: 'k' })).version, 4); // v0 + 3 rotations
  assert.deepEqual(await sk.provider.listVersions('default', 'k'), [1, 2, 3, 4]);
});

test('secrets: stress — 500 secrets store + resolve + verify is consistent', async () => {
  const clock = makeClock();
  const sk = createSecretsPlatform({ clock });
  const S = sk.secrets;
  for (let i = 0; i < 500; i++) await S.store({ name: 'k' + i, value: 'v' + i });
  assert.equal(sk.metrics.snapshot().storedSecrets, 500);
  assert.equal((await S.resolve({ name: 'k499' })).value, 'v499');
  assert.equal((await S.verifyProvider('default')).ok, true);
  assert.equal((await S.verifyIntegrity('default')).ok, true);
  assert.equal((await S.list()).length, 500);
});
