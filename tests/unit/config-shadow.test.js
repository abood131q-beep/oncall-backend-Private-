'use strict';

/**
 * config-shadow.test.js — Phase 17.3
 *
 * Configuration Kernel shadow integration:
 *   • Configuration Adapter mapping (get→get, has→exists) + inert guard
 *   • legacy source, deep-equal comparator, shadow verifier
 *   • parity (booleans/numbers/arrays/objects/null/missing), 100% match
 *   • mismatch detection + sensitive-key redaction
 *   • failure path (kernel throws) → recorded, legacy returned, never throws
 *   • feature-flag gating (both OFF = inert; SHADOW requires PLATFORM)
 *   • full enterprise boot: legacy mode, config-wired-no-shadow, config+shadow (parity 100%)
 *   • the kernel is NEVER authoritative — shadowGet always returns the legacy value
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConfigurationAdapter,
  createLegacyConfigSource,
  createConfigShadow,
  createConfigShadowMetrics,
  deepEqual,
  AdapterNotWiredError,
} = require('../../src/platform-adapters');
const { selectConfigFlags } = require('../../src/enterprise/configShadow');
const { bootEnterprise } = require('../../src/enterprise');

const quiet = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };

const SAMPLE = {
  JWT_SECRET: 'secret-xyz',
  PORT: 3000,
  IS_PRODUCTION: false,
  REQUIRE_OTP: true,
  ADMIN_PHONES: ['96599', '96588'],
  ALLOWED_ORIGINS: [],
  FIREBASE_SERVICE_ACCOUNT: { project_id: 'p', nested: { a: [1, 2] } },
  FIREBASE_PROJECT_ID: null,
  WAL_CHECKPOINT_MS: 300000,
};

/** A fake Configuration kernel port (get/exists/list/version/snapshot). */
function fakePort(values) {
  return {
    get: (k) => values[k],
    exists: (k) => Object.prototype.hasOwnProperty.call(values, k),
    list: () => Object.keys(values),
    version: () => 1,
    snapshot: () => ({ values: { ...values } }),
  };
}

// ── deep equality ────────────────────────────────────────────────────────────────
test('deepEqual across primitives, arrays, objects, null, NaN', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(false, false), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual(1, '1'), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual(null, undefined), false);
});

// ── legacy source ────────────────────────────────────────────────────────────────
test('legacy source exposes typed values from injected exports', () => {
  const legacy = createLegacyConfigSource({ exports: SAMPLE });
  assert.equal(legacy.get('PORT'), 3000);
  assert.deepEqual(legacy.get('ADMIN_PHONES'), ['96599', '96588']);
  assert.equal(legacy.has('PORT'), true);
  assert.equal(legacy.has('NOPE'), false);
  assert.equal(legacy.keys().length, Object.keys(SAMPLE).length);
});

// ── configuration adapter mapping ────────────────────────────────────────────────
test('configuration adapter is inert without a port', () => {
  const a = createConfigurationAdapter();
  assert.equal(a.consumed(), false);
  assert.throws(() => a.get('PORT'), AdapterNotWiredError);
  assert.throws(() => a.has('PORT'), AdapterNotWiredError);
});

test('configuration adapter maps get→get and has→exists on the kernel port', () => {
  const a = createConfigurationAdapter({ port: fakePort(SAMPLE) });
  assert.equal(a.consumed(), true);
  assert.equal(a.get('PORT'), 3000);
  assert.equal(a.has('PORT'), true);
  assert.equal(a.has('NOPE'), false); // exists() semantics
  assert.equal(a.version(), 1);
});

// ── shadow: disabled ─────────────────────────────────────────────────────────────
test('shadow disabled returns legacy value and performs NO comparison', () => {
  const legacy = createLegacyConfigSource({ exports: SAMPLE });
  const adapter = createConfigurationAdapter({ port: fakePort(SAMPLE) });
  const shadow = createConfigShadow({ adapter, legacy, enabled: false });
  assert.equal(shadow.enabled(), false);
  assert.equal(shadow.shadowGet('PORT'), 3000);
  const s = shadow.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.comparisons, 0); // disabled ⇒ no comparison
});

// ── shadow: enabled, 100% parity ─────────────────────────────────────────────────
test('shadow enabled reaches 100% parity across all types', () => {
  const legacy = createLegacyConfigSource({ exports: SAMPLE });
  const adapter = createConfigurationAdapter({ port: fakePort(structuredClone(SAMPLE)) });
  const shadow = createConfigShadow({ adapter, legacy, enabled: true });
  const report = shadow.verifyAll();
  assert.equal(report.enabled, true);
  assert.equal(report.comparisons, Object.keys(SAMPLE).length);
  assert.equal(report.matches, Object.keys(SAMPLE).length);
  assert.equal(report.mismatches, 0);
  assert.equal(report.verificationFailures, 0);
  assert.equal(report.parityPct, 100);
});

test('missing-key parity: absent in both ⇒ match', () => {
  const legacy = createLegacyConfigSource({ exports: SAMPLE });
  const adapter = createConfigurationAdapter({ port: fakePort(SAMPLE) });
  const shadow = createConfigShadow({ adapter, legacy, enabled: true });
  // Neither side defines this key → both undefined, both has=false → matches.
  const before = shadow.stats().matches;
  const val = shadow.shadowGet('TOTALLY_ABSENT_KEY');
  assert.equal(val, undefined);
  assert.equal(shadow.stats().matches, before + 1);
});

// ── shadow: mismatch detection + redaction ───────────────────────────────────────
test('mismatch is detected and recorded; legacy value still returned', () => {
  const legacy = createLegacyConfigSource({ exports: { PORT: 3000 } });
  const adapter = createConfigurationAdapter({ port: fakePort({ PORT: 9999 }) }); // drift!
  const shadow = createConfigShadow({ adapter, legacy, enabled: true });
  const returned = shadow.shadowGet('PORT');
  assert.equal(returned, 3000); // legacy wins
  const s = shadow.stats();
  assert.equal(s.mismatches, 1);
  assert.equal(s.mismatches_log[0].key, 'PORT');
  assert.equal(s.mismatches_log[0].legacyValue, 3000);
  assert.equal(s.mismatches_log[0].kernelValue, 9999);
});

test('sensitive keys are redacted in mismatch records', () => {
  const legacy = createLegacyConfigSource({ exports: { JWT_SECRET: 'real-secret' } });
  const adapter = createConfigurationAdapter({ port: fakePort({ JWT_SECRET: 'other' }) });
  const shadow = createConfigShadow({ adapter, legacy, enabled: true });
  shadow.shadowGet('JWT_SECRET');
  const rec = shadow.stats().mismatches_log[0];
  assert.equal(rec.sensitive, true);
  assert.equal('legacyValue' in rec, false); // raw secret NOT recorded
  assert.equal('kernelValue' in rec, false);
  assert.equal(rec.legacyType, 'string');
});

// ── shadow: failure path ─────────────────────────────────────────────────────────
test('kernel read failure is recorded and legacy value is returned (never throws)', () => {
  const legacy = createLegacyConfigSource({ exports: { PORT: 3000 } });
  const throwingAdapter = {
    consumed: () => true,
    get: () => {
      throw new Error('kernel boom');
    },
    has: () => {
      throw new Error('kernel boom');
    },
  };
  const shadow = createConfigShadow({ adapter: throwingAdapter, legacy, enabled: true });
  let returned;
  assert.doesNotThrow(() => {
    returned = shadow.shadowGet('PORT');
  });
  assert.equal(returned, 3000);
  const s = shadow.stats();
  assert.equal(s.verificationFailures, 1);
  assert.equal(s.comparisons, 0);
});

// ── metrics ──────────────────────────────────────────────────────────────────────
test('metrics track requests, comparisons, matches, mismatches, latency', () => {
  const m = createConfigShadowMetrics();
  m.recordRequest();
  m.recordComparison(true, 2);
  m.recordComparison(false, 4);
  const s = m.snapshot();
  assert.equal(s.requests, 1);
  assert.equal(s.comparisons, 2);
  assert.equal(s.matches, 1);
  assert.equal(s.mismatches, 1);
  assert.equal(s.parityPct, 50);
  assert.equal(s.latency.samples, 2);
  assert.equal(s.latency.maxMs, 4);
});

// ── feature-flag gating ──────────────────────────────────────────────────────────
test('selectConfigFlags: SHADOW requires PLATFORM', () => {
  assert.deepEqual(selectConfigFlags({ PLATFORM_CONFIG: '1', SHADOW_CONFIG: '1' }), {
    platformConfig: true,
    shadowConfig: true,
  });
  assert.deepEqual(selectConfigFlags({ PLATFORM_CONFIG: '0', SHADOW_CONFIG: '1' }), {
    platformConfig: false,
    shadowConfig: false, // shadow cannot run without platform
  });
  assert.deepEqual(selectConfigFlags({ PLATFORM_CONFIG: '1' }), {
    platformConfig: true,
    shadowConfig: false,
  });
  assert.deepEqual(selectConfigFlags({}), { platformConfig: false, shadowConfig: false });
});

// ── full enterprise boot integration (fake app; no sqlite) ───────────────────────
function fakeApp() {
  let listening = false;
  return {
    port: 3999,
    listening: () => listening,
    start: async () => {
      listening = true;
    },
    stop: async () => {
      listening = false;
    },
  };
}

test('boot with both flags OFF is identical to 17.2 (no consumption, no shadow)', async () => {
  const { adapters, configShadow, parity, flags, host } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformConfig: false,
    shadowConfig: false,
  });
  assert.deepEqual(adapters.consumed(), []);
  assert.equal(configShadow, null);
  assert.equal(parity, null);
  assert.equal(flags.platformConfig, false);
  assert.equal(flags.shadowConfig, false);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot PLATFORM_CONFIG=1, SHADOW_CONFIG=0: adapter wired, no comparisons', async () => {
  const { adapters, configShadow, parity, host } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformConfig: true,
    shadowConfig: false,
    envExports: SAMPLE,
  });
  assert.deepEqual(adapters.consumed(), ['configuration']);
  assert.equal(configShadow.enabled(), false); // shadow off
  assert.equal(parity, null); // no parity pass ran
  assert.equal((await host.verify()).ok, true); // shadow-only adapter is allowed
  await host.stop();
});

test('boot with both flags ON: parity 100% and host healthy', async () => {
  const { configShadow, parity, host, service } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformConfig: true,
    shadowConfig: true,
    envExports: SAMPLE,
  });
  assert.equal(parity.parityPct, 100);
  assert.equal(parity.mismatches, 0);
  assert.equal(parity.verificationFailures, 0);
  assert.equal(parity.comparisons, Object.keys(SAMPLE).length);
  assert.equal((await host.health()).status, 'healthy');
  assert.equal(service.metadata().phase, '17.3');
  assert.deepEqual(service.metadata().kernelsConsumed, ['configuration']);
  // kernel never authoritative: shadowGet returns legacy value
  assert.equal(configShadow.shadowGet('PORT'), 3000);
  await host.stop();
});
