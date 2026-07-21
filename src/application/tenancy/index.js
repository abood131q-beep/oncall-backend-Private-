'use strict';

/**
 * Multi-Tenancy Platform — composition entry point (Phase 15.9 / ADR-038). Wires the
 * service with a provider + context cache + metrics and returns the Kernel Service as
 * one factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the tenancy kernel is instantiated.
 *
 *   const tk = createTenancyPlatform({ publisher, defaults: { capabilities: ['base'] } });
 *   const t = await tk.tenancy.registerTenant({ tenantName: 'acme', capabilities: ['premium'] });
 *   await tk.tenancy.activateTenant({ tenantId: t.tenantId });
 *   const ctx = await tk.tenancy.resolveTenant({ tenantId: t.tenantId });
 */

const { createTenancyService } = require('./tenancyService');
const { createTenancyMetrics } = require('./metrics');
const { createContextCache } = require('./cache');
const providers = require('./providers');
const tenancyPort = require('./tenancyPort');
const providerPort = require('./providerPort');
const { TENANT_EVENTS } = require('../../domain/tenancy/events');

function createTenancyPlatform(deps = {}) {
  const metrics = deps.metrics || createTenancyMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const cache = deps.cache || createContextCache({ maxSize: deps.cacheMaxSize });
  const tenancy = createTenancyService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    defaults: deps.defaults,
    historyLimit: deps.historyLimit,
  });
  return { tenancy, provider, cache, metrics, TENANT_EVENTS };
}

module.exports = {
  createTenancyPlatform,
  createTenancyService,
  createTenancyMetrics,
  createContextCache,
  providers,
  tenancyPort,
  providerPort,
  TENANT_EVENTS,
};
