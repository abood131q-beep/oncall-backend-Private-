'use strict';

/**
 * Configuration Platform — composition entry point (Phase 14.3.2).
 *
 * Wires the config service with a cache + metrics + providers and returns the
 * whole platform as one factory. Purely additive: nothing here is imported by a
 * hot path, so the platform runs byte-identically whether or not the config
 * platform is instantiated. `init()` builds the first snapshot (async provider
 * load); after that the read API (get/require/exists/list/snapshot/version) is
 * synchronous.
 *
 *   const cfg = createConfigurationPlatform({
 *     defaults: { 'http.port': 3000 },
 *     providers: [createEnvProvider({ prefix: 'APP_' })],
 *     schema: { properties: { 'http.port': { type: 'integer', min: 1, max: 65535 } } },
 *     publisher,          // EventPublisher port (ADR-016)
 *   });
 *   await cfg.init();
 *   cfg.service.get('http.port');
 */

const { createConfigService } = require('./configService');
const { createConfigCache } = require('./cache');
const { createConfigMetrics } = require('./metrics');
const providers = require('./providers');
const providerPort = require('./providerPort');
const { CONFIG_EVENTS } = require('../../domain/config/events');

function createConfigurationPlatform(deps = {}) {
  const metrics = deps.metrics || createConfigMetrics({ clock: deps.metricsClock });
  const cache = deps.cache || createConfigCache({ metrics });
  const service = createConfigService({
    providers: deps.providers,
    defaults: deps.defaults,
    overrides: deps.overrides,
    schema: deps.schema,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    redactionPatterns: deps.redactionPatterns,
  });

  return {
    service,
    cache,
    metrics,
    CONFIG_EVENTS,
    /** Build the first snapshot. Safe to call again to force a full reload. */
    init: () => service.reload({ origin: 'init' }),
  };
}

module.exports = {
  createConfigurationPlatform,
  createConfigService,
  createConfigCache,
  createConfigMetrics,
  providers,
  providerPort,
  CONFIG_EVENTS,
};
