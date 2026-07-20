'use strict';

/**
 * Example extension — "surge-pricing" (Phase 14.2 reference).
 *
 * Demonstrates the complete contract: a validated manifest, a deny-all sandbox
 * (only `read:pricing` granted), and a Before* hook that can veto a ride request
 * under extreme surge. Illustrative only — not wired into the platform.
 *
 * Load it (host side):
 *   const platform = createExtensionPlatform({
 *     env: { platformVersion: '1.4.0', platformApiRange: '^1.0.0' },
 *     portFactories: { 'read:pricing': () => pricingReadPort },
 *   });
 *   await platform.registry.install(require('./docs/examples/surge-pricing-extension'));
 *   await platform.registry.enable('surge-pricing');
 */

const { checksum } = require('../../src/domain/extensions/integrity');

const manifest = {
  id: 'surge-pricing',
  name: 'Surge Pricing',
  version: '1.0.0',
  apiVersion: '1.0.0',
  author: 'OnCall Labs',
  description:
    'Applies a surge multiplier within authored city bounds and can veto a ride request under extreme demand.',
  permissions: ['read:pricing'], // deny-all otherwise: no DB, no secrets, no network
  capabilities: ['RidePricing'],
  dependencies: {},
  minimumPlatformVersion: '1.0.0',
  compatibilityRules: { apiVersionRange: '^1.0.0' },
  lifecycleHooks: ['BeforeRideRequest'],
  configurationSchema: {
    type: 'object',
    properties: { maxMultiplier: { type: 'number', default: 2.5 } },
  },
  healthChecks: [{ name: 'pricing-port-reachable', intervalMs: 30000 }],
};

// The bundle bytes an operator would checksum/sign; here just the manifest text.
const bytes = JSON.stringify(manifest);

module.exports = {
  manifest,
  bytes,
  checksum: checksum(bytes), // integrity gate passes for this example
  register(ctx, api) {
    const pricing = ctx['read:pricing']; // only granted port; undefined if not granted

    api.registerHook('BeforeRideRequest', (hookCtx) => {
      // Read-only pricing access via the sandboxed port.
      const demand = hookCtx.demandIndex ?? 1;
      const base =
        pricing && typeof pricing.currentMultiplier === 'function'
          ? pricing.currentMultiplier(hookCtx.cityRef)
          : 1;
      const effective = base * demand;

      // Before* hooks may veto by returning { cancel, reason }.
      if (effective > (manifest.configurationSchema.properties.maxMultiplier.default || 2.5)) {
        return { cancel: true, reason: `surge ${effective.toFixed(2)}x exceeds cap` };
      }
      return { surgeMultiplier: effective }; // advisory patch (host decides to apply)
    });

    // Optional teardown on disable/unload.
    return () => {
      /* release any resources here */
    };
  },
};
