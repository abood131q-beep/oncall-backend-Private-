'use strict';

/**
 * Storage Platform — composition entry point (Phase 14.3.4). Wires the service
 * with a provider + cache + metrics and returns the whole Kernel Service as one
 * factory. Purely additive: nothing here is imported by a hot path, so the
 * platform runs byte-identically whether or not storage is instantiated.
 *
 *   const st = createStoragePlatform({ provider: providers.createMemoryProvider(), publisher });
 *   await st.storage.put({ namespace: 'ext.foo', key: 'a', value: { n: 1 } });
 */

const { createStorageService } = require('./storageService');
const { createStorageCache } = require('./cache');
const { createStorageMetrics } = require('./metrics');
const providers = require('./providers');
const providerPort = require('./providerPort');
const { STORAGE_EVENTS } = require('../../domain/storage/events');

function createStoragePlatform(deps = {}) {
  const metrics = deps.metrics || createStorageMetrics({ clock: deps.clock });
  const cache =
    deps.cache !== undefined
      ? deps.cache
      : createStorageCache({ metrics, writeThrough: deps.writeThrough });
  const provider = deps.provider || providers.createMemoryProvider();
  const storage = createStorageService({
    provider,
    publisher: deps.publisher,
    metrics,
    cache,
    clock: deps.clock,
    logger: deps.logger,
  });

  return { storage, provider, cache, metrics, STORAGE_EVENTS };
}

module.exports = {
  createStoragePlatform,
  createStorageService,
  createStorageCache,
  createStorageMetrics,
  providers,
  providerPort,
  STORAGE_EVENTS,
};
