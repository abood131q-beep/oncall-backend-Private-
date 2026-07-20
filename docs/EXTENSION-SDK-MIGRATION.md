# Migration Guide — Raw Packages → Extension SDK (Phase 14.3.1)

Extensions written directly against the Phase-14.2 platform (a hand-authored `manifest`
plus a `register(ctx, api)` function) **keep working** — the SDK produces the identical
package shape, so nothing you already shipped breaks. This guide shows how to move a raw
extension to the SDK to delete boilerplate and gain the config/logger/health/testing APIs.

## Before — raw package (`docs/examples/surge-pricing-extension.js`)

```js
const { checksum } = require('../../src/domain/extensions/integrity');

const manifest = {
  id: 'surge-pricing',
  name: 'Surge Pricing',
  version: '1.0.0',
  apiVersion: '1.0.0',
  author: 'OnCall Labs',
  description: '…',
  permissions: ['read:pricing'],
  capabilities: ['RidePricing'], // hand-maintained
  dependencies: {},
  minimumPlatformVersion: '1.0.0',
  compatibilityRules: { apiVersionRange: '^1.0.0' },
  lifecycleHooks: ['BeforeRideRequest'], // hand-maintained, must match register()
  configurationSchema: { type: 'object', properties: { maxMultiplier: { type: 'number', default: 2.5 } } },
  healthChecks: [{ name: 'pricing-port-reachable', intervalMs: 30000 }],
};
const bytes = JSON.stringify(manifest);

module.exports = {
  manifest,
  bytes,
  checksum: checksum(bytes),
  register(ctx, api) {
    const pricing = ctx['read:pricing'];
    api.registerHook('BeforeRideRequest', (hookCtx) => {
      const effective = (pricing?.currentMultiplier(hookCtx.cityRef) ?? 1) * (hookCtx.demandIndex ?? 1);
      if (effective > (manifest.configurationSchema.properties.maxMultiplier.default || 2.5)) {
        return { cancel: true, reason: `surge ${effective.toFixed(2)}x exceeds cap` };
      }
      return { surgeMultiplier: effective };
    });
    return () => {};
  },
};
```

## After — SDK (`docs/examples/surge-pricing-sdk-extension.js`)

```js
const { Extension } = require('../../src/sdk/extensions');

class SurgePricing extends Extension {
  constructor() {
    super({
      id: 'surge-pricing', name: 'Surge Pricing', version: '1.0.0', apiVersion: '1.0.0',
      author: 'OnCall Labs', description: '…', permissions: ['read:pricing'],
      compatibilityRules: { apiVersionRange: '^1.0.0' },
      configurationSchema: { type: 'object', properties: { maxMultiplier: { type: 'number', default: 2.5 } } },
      healthChecks: [{ name: 'pricing-port-reachable', intervalMs: 30000 }],
    });
    this.providesCapability('RidePricing');
    this.beforeRideRequest((ctx) => this.evaluate(ctx));
  }
  onEnable() { this.healthy('active'); }
  evaluate(ctx) {
    const mult = (this._ctx['read:pricing']?.currentMultiplier(ctx.cityRef) ?? 1) * (ctx.demandIndex ?? 1);
    return mult > this.config().maxMultiplier
      ? { cancel: true, reason: `surge ${mult.toFixed(2)}x exceeds cap` }
      : { surgeMultiplier: mult };
  }
}
module.exports = { SurgePricing };
```

## What changed

| Concern            | Raw package                                   | SDK                                          |
| ------------------ | --------------------------------------------- | -------------------------------------------- |
| Manifest           | hand-written object                           | derived from `super({...})` + declarations   |
| `capabilities`     | hand-maintained array                         | `providesCapability()`                        |
| `lifecycleHooks`   | hand-maintained, must match `register()`      | derived from `beforeRideRequest()` etc.       |
| bytes/checksum     | manual                                        | computed by `toPackage()`                     |
| `register(ctx,api)`| manual wiring + teardown                       | gone — SDK flushes hooks + runs lifecycle     |
| config defaults    | read from schema by hand                      | `config()` / `validateConfig()`               |
| logging            | none / ad-hoc                                 | `this.logger.*` auto-enriched                 |
| health             | none                                          | `healthy()/degraded()/failed()/notReady()`    |
| tests              | boot a platform                               | `testKit.harness()` — no platform             |

## Migration steps

1. `class MyExt extends Extension` and move the manifest fields into `super({...})`
   (drop `capabilities` and `lifecycleHooks` — they are derived).
2. Replace each `api.registerHook('X', fn)` with the matching `this.x(fn)` method.
3. Replace `ctx['perm']` reads with `this._ctx['perm']` (available after enable).
4. Move any `register` setup into `onEnable()` and any teardown into `onDisable()`.
5. Export the class; install with `new MyExt().toPackage()`.
6. Rewrite tests against `testKit.harness()`.

## Compatibility guarantee

- The SDK emits the **same** `{ manifest, bytes, checksum, register(ctx, api) }` contract,
  so the registry, resolver, sandbox, hookBus, and metrics treat SDK and raw extensions
  identically.
- No platform hot path imports the SDK; migrating an extension changes nothing about the
  running server. The raw example remains in the repo as a reference and still installs.
