'use strict';

/**
 * Enterprise Extension SDK tests (Phase 14.3.1) — cover the base class, hook API,
 * capability API, configuration API, logger enrichment, event API (ports only),
 * health API, the standard error model, and the testing kit (mock ctx/ports/
 * events/config + harness with real hook semantics). No platform boot required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Extension,
  HEALTH,
  ConfigurationError,
  CapabilityError,
  PermissionError,
  HookRegistrationError,
  ManifestError,
  testKit,
} = require('../../src/sdk/extensions');

const baseSpec = (over = {}) => ({
  id: 'demo-ext',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '1.0.0',
  author: 'OnCall Labs',
  description: 'A demo extension for the SDK test suite',
  permissions: [],
  minimumPlatformVersion: '1.0.0',
  ...over,
});

const fixedClock = () => '2026-07-20T00:00:00.000Z';

// ── manifest derivation + packaging ──────────────────────────────────────────

test('SDK: derives manifest (capabilities + lifecycleHooks) and packages it', () => {
  class E extends Extension {
    constructor() {
      super(baseSpec({ permissions: ['read:pricing'] }));
      this.providesCapability('RidePricing');
      this.beforeRideRequest(() => ({}));
      this.afterPayment(() => ({}));
    }
  }
  const pkg = new E().toPackage();
  assert.equal(pkg.manifest.id, 'demo-ext');
  assert.deepEqual(pkg.manifest.capabilities, ['RidePricing']);
  assert.deepEqual([...pkg.manifest.lifecycleHooks].sort(), ['AfterPayment', 'BeforeRideRequest']);
  assert.ok(typeof pkg.checksum === 'string' && pkg.checksum.length === 64);
  assert.equal(typeof pkg.register, 'function');
});

test('SDK: invalid manifest is rejected via ManifestError at toPackage()', () => {
  class Bad extends Extension {
    constructor() {
      super(baseSpec({ id: 'X' })); // invalid id
    }
  }
  assert.throws(() => new Bad().toPackage(), ManifestError);
});

// ── capability API ────────────────────────────────────────────────────────────

test('SDK: providesCapability rejects unknown capability with CapabilityError', () => {
  class E extends Extension {
    constructor() {
      super(baseSpec());
    }
  }
  const e = new E();
  assert.throws(() => e.providesCapability('WorldDomination'), CapabilityError);
  e.providesCapability('AIProvider');
  assert.deepEqual(e._manifest().capabilities, ['AIProvider']);
});

// ── hook API ────────────────────────────────────────────────────────────────

test('SDK: every catalog hook has a registration method; non-function rejected', () => {
  class E extends Extension {
    constructor() {
      super(baseSpec());
    }
  }
  const e = new E();
  for (const m of [
    'beforeRideRequest',
    'afterRideCreated',
    'beforePayment',
    'afterPayment',
    'tripStarted',
    'tripCompleted',
  ]) {
    assert.equal(typeof e[m], 'function', `missing hook method ${m}`);
  }
  assert.throws(() => e.beforePayment('not-a-fn'), HookRegistrationError);
});

// ── configuration API ─────────────────────────────────────────────────────────

test('SDK: validateConfig applies defaults, enforces types + required', () => {
  class E extends Extension {
    constructor() {
      super(
        baseSpec({
          configurationSchema: {
            type: 'object',
            required: ['region'],
            properties: {
              maxMultiplier: { type: 'number', default: 2.5 },
              region: { type: 'string' },
            },
          },
        })
      );
    }
  }
  const e = new E();
  const ok = e.validateConfig({ region: 'us' });
  assert.equal(ok.maxMultiplier, 2.5); // default applied
  assert.equal(ok.region, 'us');
  assert.throws(() => e.validateConfig({}), ConfigurationError); // missing required
  assert.throws(() => e.validateConfig({ region: 5 }), ConfigurationError); // wrong type
});

test('SDK: reloadConfig reads provider, validates, fires onConfigurationChanged', async () => {
  const changes = [];
  class E extends Extension {
    constructor() {
      super(
        baseSpec({
          configurationSchema: {
            type: 'object',
            properties: { rate: { type: 'number', default: 1 } },
          },
        }),
        { clock: fixedClock }
      );
    }
    onConfigurationChanged(next, prev) {
      changes.push({ next, prev });
    }
  }
  const cfg = testKit.createMockConfig({ rate: 3 });
  const e = new E();
  const h = await testKit.harness(e, { config: cfg });
  const applied = await h.reloadConfig();
  assert.equal(applied.rate, 3);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].next.rate, 3);
});

// ── logger enrichment ─────────────────────────────────────────────────────────

test('SDK: logger auto-includes id, version, correlationId, timestamp', () => {
  class E extends Extension {
    constructor() {
      super(baseSpec(), { clock: fixedClock });
    }
  }
  const mock = testKit.createMockLogger();
  const e = new E();
  // buildLogger reads _baseLogger at call time, so swapping it in is enough.
  e._baseLogger = mock;
  e.withCorrelation('corr-123');
  e.logger.info('hello', { a: 1 });
  const line = mock.lines[0];
  assert.equal(line.record.extensionId, 'demo-ext');
  assert.equal(line.record.version, '1.0.0');
  assert.equal(line.record.correlationId, 'corr-123');
  assert.equal(line.record.timestamp, '2026-07-20T00:00:00.000Z');
  assert.equal(line.record.message, 'hello');
  assert.deepEqual(line.record.meta, { a: 1 });
});

// ── event API (ports only) ─────────────────────────────────────────────────────

test('SDK: publish/subscribe go through granted ports; deny otherwise', async () => {
  class Pub extends Extension {
    constructor() {
      super(baseSpec({ permissions: ['publish:events', 'subscribe:events'] }));
    }
  }
  const events = testKit.createMockEvents();
  const e = new Pub();
  const h = await testKit.harness(e, {
    ports: { 'publish:events': events, 'subscribe:events': events },
  });
  void h;
  await e.publish({ type: 'X', payload: {} });
  assert.equal(events.published.length, 1);

  const received = [];
  e.subscribe('X', (ev) => received.push(ev));
  await events.emit('X', { type: 'X', payload: { n: 1 } });
  assert.equal(received.length, 1);

  // Deny path: an extension without the permission cannot publish.
  class NoPub extends Extension {
    constructor() {
      super(baseSpec({ permissions: [] }));
    }
  }
  const e2 = new NoPub();
  await testKit.harness(e2, { ports: {} });
  await assert.rejects(() => e2.publish({ type: 'X' }), PermissionError);
});

// ── health API ────────────────────────────────────────────────────────────────

test('SDK: health helpers set status; runHealthCheck honors onHealthCheck', async () => {
  class E extends Extension {
    constructor() {
      super(baseSpec(), { clock: fixedClock });
    }
    onHealthCheck() {
      return { status: HEALTH.DEGRADED, detail: 'slow port' };
    }
  }
  const e = new E();
  e.healthy('ok');
  assert.equal(e.health().status, HEALTH.HEALTHY);
  e.failed('boom');
  assert.equal(e.health().status, HEALTH.FAILED);
  const hc = await e.runHealthCheck();
  assert.equal(hc.status, HEALTH.DEGRADED);
  assert.equal(hc.detail, 'slow port');
});

// ── lifecycle ──────────────────────────────────────────────────────────────────

test('SDK: lifecycle fires onInstall→onEnable once, onDisable/onUnload on teardown', async () => {
  const calls = [];
  class E extends Extension {
    constructor() {
      super(baseSpec({ permissions: [] }), { clock: fixedClock });
    }
    onInstall() {
      calls.push('install');
    }
    onEnable() {
      calls.push('enable');
    }
    onDisable() {
      calls.push('disable');
    }
    onUnload() {
      calls.push('unload');
    }
  }
  const e = new E();
  const h = await testKit.harness(e, { ports: {} });
  assert.deepEqual(calls, ['install', 'enable']);
  await h.disable();
  assert.deepEqual(calls, ['install', 'enable', 'disable']);
  await e.unload();
  assert.deepEqual(calls, ['install', 'enable', 'disable', 'unload']);
});

// ── testKit harness runs real hook semantics (veto + isolation) ───────────────

test('SDK testKit: harness runs Before* veto through the real hookBus', async () => {
  class Surge extends Extension {
    constructor() {
      super(baseSpec({ id: 'surge-demo', permissions: ['read:pricing'] }));
      this.providesCapability('RidePricing');
      this.beforeRideRequest((ctx) => {
        const mult = this._ctx['read:pricing'].currentMultiplier() * (ctx.demandIndex ?? 1);
        return mult > 2.5 ? { cancel: true, reason: 'too high' } : { surgeMultiplier: mult };
      });
    }
  }
  const h = await testKit.harness(new Surge(), {
    ports: { 'read:pricing': { currentMultiplier: () => 2 } },
  });
  const pass = await h.runHook('BeforeRideRequest', { demandIndex: 1 });
  assert.equal(pass.cancelled, false);
  const veto = await h.runHook('BeforeRideRequest', { demandIndex: 3 });
  assert.equal(veto.cancelled, true);
  assert.match(veto.reason, /too high/);
});

test('SDK testKit: a throwing hook is isolated (fail-open), not thrown to caller', async () => {
  class Bad extends Extension {
    constructor() {
      super(baseSpec({ id: 'bad-demo' }));
      this.afterPayment(() => {
        throw new Error('kaboom');
      });
    }
  }
  const h = await testKit.harness(new Bad(), { ports: {} });
  const res = await h.runHook('AfterPayment', { paymentRef: 'p1' });
  assert.equal(res.cancelled, false);
  assert.equal(res.results[0].ok, false);
});

// ── end-to-end through the REAL platform registry (integration) ───────────────

test('SDK: package installs + enables through the real extension platform', async () => {
  const { createExtensionPlatform } = require('../../src/application/extensions');
  class Surge extends Extension {
    constructor() {
      super(baseSpec({ id: 'surge-e2e', permissions: ['read:pricing'] }), { clock: fixedClock });
      this.providesCapability('RidePricing');
      this.beforeRideRequest((ctx) => {
        const p = this._ctx['read:pricing'];
        const mult = (p ? p.currentMultiplier() : 1) * (ctx.demandIndex ?? 1);
        return mult > 2.5 ? { cancel: true, reason: `surge ${mult}` } : { surgeMultiplier: mult };
      });
    }
  }
  const platform = createExtensionPlatform({
    env: { platformVersion: '1.4.0', platformApiRange: '^1.0.0' },
    portFactories: { 'read:pricing': () => ({ currentMultiplier: () => 2 }) },
    logger: { warn() {}, error() {}, info() {} },
  });
  await platform.registry.install(new Surge().toPackage());
  const enabled = await platform.registry.enable('surge-e2e');
  assert.equal(enabled.state, 'enabled');
  const veto = await platform.hookBus.run('BeforeRideRequest', { demandIndex: 3 });
  assert.equal(veto.cancelled, true);
  const ok = await platform.hookBus.run('BeforeRideRequest', { demandIndex: 1 });
  assert.equal(ok.cancelled, false);
});
