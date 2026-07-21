'use strict';

/**
 * Rate Limiting Platform — composition entry point (Phase 15.2 / ADR-031). Wires the
 * service with a provider + usage cache + metrics and returns the Kernel Service as
 * one factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the rate-limiting kernel is instantiated.
 *
 *   const rl = createRateLimitPlatform({ publisher });
 *   await rl.ratelimit.registerPolicy({ name: 'api', limit: 100, window: 60000, algorithm: 'token_bucket' });
 *   const r = await rl.ratelimit.consume({ policyId, subject: 'user-1' });
 *   if (!r.allowed) reject(429);
 */

const { createRateLimitService } = require('./ratelimitService');
const { createRateLimitMetrics } = require('./metrics');
const { createUsageCache } = require('./cache');
const providers = require('./providers');
const ratelimitPort = require('./ratelimitPort');
const providerPort = require('./providerPort');
const { RATE_EVENTS } = require('../../domain/ratelimit/events');

function createRateLimitPlatform(deps = {}) {
  const metrics = deps.metrics || createRateLimitMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const cache = deps.cache || createUsageCache({ maxSize: deps.cacheMaxSize });
  const ratelimit = createRateLimitService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { ratelimit, provider, cache, metrics, RATE_EVENTS };
}

module.exports = {
  createRateLimitPlatform,
  createRateLimitService,
  createRateLimitMetrics,
  createUsageCache,
  providers,
  ratelimitPort,
  providerPort,
  RATE_EVENTS,
};
