'use strict';

/**
 * Feature Flag Platform — composition entry point (Phase 15.0 / ADR-029). Wires the
 * service with a provider + cache + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the feature-flag kernel is instantiated.
 *
 *   const ff = createFeaturePlatform({ publisher });
 *   await ff.features.register({ name: 'new-checkout', defaultValue: true, rollout: { percentage: 25 } });
 *   await ff.features.enable({ name: 'new-checkout' });
 *   const r = await ff.features.evaluate({ name: 'new-checkout', context: { key: 'user-1', platform: 'ios' } });
 */

const { createFeaturesService } = require('./featuresService');
const { createFeatureMetrics } = require('./metrics');
const { createEvaluationCache } = require('./cache');
const providers = require('./providers');
const featuresPort = require('./featuresPort');
const providerPort = require('./providerPort');
const { FEATURE_EVENTS } = require('../../domain/features/events');

function createFeaturePlatform(deps = {}) {
  const metrics = deps.metrics || createFeatureMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const cache = deps.cache || createEvaluationCache({ maxSize: deps.cacheMaxSize });
  const features = createFeaturesService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { features, provider, cache, metrics, FEATURE_EVENTS };
}

module.exports = {
  createFeaturePlatform,
  createFeaturesService,
  createFeatureMetrics,
  createEvaluationCache,
  providers,
  featuresPort,
  providerPort,
  FEATURE_EVENTS,
};
