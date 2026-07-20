'use strict';

/**
 * Example extension built with the Enterprise Extension SDK (Phase 14.3.1).
 *
 * Same behavior as docs/examples/surge-pricing-extension.js, but with ZERO manual
 * wiring: no hand-written manifest object, no bytes/checksum bookkeeping, no
 * `register(ctx, api)` plumbing. The SDK derives the manifest (capabilities +
 * lifecycleHooks), enforces the sandbox, and packages it.
 *
 *   const platform = createExtensionPlatform({
 *     env: { platformVersion: '1.4.0', platformApiRange: '^1.0.0' },
 *     portFactories: { 'read:pricing': () => pricingReadPort },
 *   });
 *   await platform.registry.install(new SurgePricing().toPackage());
 *   await platform.registry.enable('surge-pricing');
 */

const { Extension } = require('../../src/sdk/extensions');

class SurgePricing extends Extension {
  constructor() {
    super({
      id: 'surge-pricing',
      name: 'Surge Pricing',
      version: '1.0.0',
      apiVersion: '1.0.0',
      author: 'OnCall Labs',
      description:
        'Applies a surge multiplier within authored bounds and can veto a ride request under extreme demand.',
      permissions: ['read:pricing'], // deny-all otherwise: no DB, secrets, or network
      minimumPlatformVersion: '1.0.0',
      compatibilityRules: { apiVersionRange: '^1.0.0' },
      configurationSchema: {
        type: 'object',
        properties: { maxMultiplier: { type: 'number', default: 2.5 } },
      },
      healthChecks: [{ name: 'pricing-port-reachable', intervalMs: 30000 }],
    });

    // Declarative capability + hook registration — validated by the SDK.
    this.providesCapability('RidePricing');
    this.beforeRideRequest((ctx) => this.evaluate(ctx));
  }

  onEnable() {
    this.healthy('surge pricing active');
    this.logger.info('surge-pricing enabled');
  }

  evaluate(ctx) {
    const pricing = this._ctx['read:pricing']; // only granted port
    const demand = ctx.demandIndex ?? 1;
    const base =
      pricing && typeof pricing.currentMultiplier === 'function'
        ? pricing.currentMultiplier(ctx.cityRef)
        : 1;
    const effective = base * demand;
    const cap = this.config().maxMultiplier ?? 2.5;

    if (effective > cap) {
      return { cancel: true, reason: `surge ${effective.toFixed(2)}x exceeds cap` };
    }
    return { surgeMultiplier: effective }; // advisory patch (host decides to apply)
  }
}

module.exports = { SurgePricing };
