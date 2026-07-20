# OnCall Enterprise Extension SDK — Guide (Phase 14.3.1)

The SDK is the **only supported way** to build an OnCall extension. It sits on top of
the Extension Platform (ADR-017) and removes all manual wiring: you declare identity,
capabilities, and hooks with a framework-style API, and the SDK derives the manifest,
enforces the sandbox, and produces a registry-compatible package.

```js
const { Extension } = require('oncall/src/sdk/extensions');
```

## 1. Your first extension

```js
const { Extension } = require('../../src/sdk/extensions');

class SurgePricing extends Extension {
  constructor() {
    super({
      id: 'surge-pricing', // ^[a-z][a-z0-9-]{2,63}$
      name: 'Surge Pricing',
      version: '1.0.0', // semver
      apiVersion: '1.0.0',
      author: 'OnCall Labs',
      description: 'Applies a surge multiplier and can veto extreme rides.',
      permissions: ['read:pricing'], // deny-all otherwise
      configurationSchema: {
        type: 'object',
        properties: { maxMultiplier: { type: 'number', default: 2.5 } },
      },
    });

    this.providesCapability('RidePricing'); // declarative
    this.beforeRideRequest((ctx) => this.evaluate(ctx)); // clean hook API
  }

  onEnable() {
    this.healthy('active');
  }

  evaluate(ctx) {
    const mult = this._ctx['read:pricing'].currentMultiplier(ctx.cityRef) * (ctx.demandIndex ?? 1);
    return mult > this.config().maxMultiplier
      ? { cancel: true, reason: `surge ${mult.toFixed(2)}x exceeds cap` }
      : { surgeMultiplier: mult };
  }
}

// Install through the platform:
await platform.registry.install(new SurgePricing().toPackage());
await platform.registry.enable('surge-pricing');
```

You never write a manifest object, checksum, or `register(ctx, api)` block. `toPackage()`
derives `capabilities` (from `providesCapability`) and `lifecycleHooks` (from the hooks you
registered), validates the whole manifest, and computes the checksum.

## 2. Lifecycle methods (all optional)

| Method                    | When it runs                                             |
| ------------------------- | -------------------------------------------------------- |
| `onInstall()`             | first enable, once                                       |
| `onEnable()`              | every enable / reload                                    |
| `onDisable()`             | disable / reload teardown                                |
| `onUnload()`              | explicit unload                                          |
| `onHealthCheck()`         | when the host calls `runHealthCheck()`; return `{status}`|
| `onConfigurationChanged(next, prev)` | after a successful `reloadConfig()`           |

## 3. Hook API

One method per catalog hook — no registry internals:

```
this.beforeRideRequest(fn)   this.afterRideCreated(fn)
this.beforePayment(fn)       this.afterPayment(fn)
this.beforeUnlock(fn)        this.afterUnlock(fn)
this.tripStarted(fn)         this.tripCompleted(fn)
this.driverApproved(fn)      this.scooterReturned(fn)
this.userRegistered(fn)      this.organizationCreated(fn)
```

`Before*` handlers may return `{ cancel: true, reason }` to veto a flow. All others are
observational. A handler that throws or exceeds the timeout is isolated (fail-open) and
never crashes the platform or another extension.

## 4. Capability API

```js
this.providesCapability('RidePricing'); // validated against the closed vocabulary
```

Valid: RidePricing, PaymentProvider, VehicleProvider, NotificationProvider,
TelemetryProvider, IdentityProvider, StorageProvider, AIProvider, MapsProvider,
DispatchProvider. An unknown capability throws `CapabilityError`.

## 5. Configuration API

```js
this.config(); // frozen current config
await this.reloadConfig(); // re-read + validate + onConfigurationChanged
this.validateConfig(candidate); // defaults + type + required checks; throws ConfigurationError
```

Config comes from a provider you inject (`{ configProvider }`) or the granted `read:config`
port. Defaults from your `configurationSchema` are applied automatically.

## 6. Logger API

```js
this.logger.info(message, meta);
this.logger.warn(message, meta);
this.logger.error(message, meta);
this.logger.debug(message, meta);
```

Every line is automatically enriched with `extensionId`, `version`, `correlationId`, and a
`timestamp`. Set the correlation id with `this.withCorrelation(id)`.

## 7. Event API (ports only)

```js
await this.publish(event); // requires permission publish:events
this.subscribe(type, handler); // requires permission subscribe:events
```

These go through the granted EventPublisher **port** — never a direct EventBus. Without the
permission, they throw `PermissionError`.

## 8. Health API

```js
this.healthy(detail);
this.degraded(detail);
this.failed(detail);
this.notReady(detail);
```

## 9. Error model

`ExtensionError` (base) → `ConfigurationError`, `CapabilityError`, `PermissionError`,
`HookRegistrationError`, plus the platform-wide `ManifestError`. Branch on
`err instanceof …` or `err.name`.

## 10. Testing (no platform boot)

```js
const { testKit } = require('../../src/sdk/extensions');

const events = testKit.createMockEvents();
const h = await testKit.harness(new SurgePricing(), {
  ports: { 'read:pricing': { currentMultiplier: () => 3 }, 'publish:events': events },
  config: testKit.createMockConfig({ maxMultiplier: 2.5 }),
});

const res = await h.runHook('BeforeRideRequest', { demandIndex: 2, cityRef: 'NYC' });
assert.equal(res.cancelled, true); // real hookBus veto semantics
```

`testKit` exports `harness`, `createMockContext`, `createMockPorts`, `createMockEvents`,
`createMockConfig`, and `createMockLogger`. The harness runs your hooks through the **real**
hookBus, so isolation, timeout, and veto behavior are faithful without a running platform.

See `docs/examples/surge-pricing-sdk-extension.js` for the full example.
