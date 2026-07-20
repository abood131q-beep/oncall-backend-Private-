'use strict';

/**
 * Lock Platform — composition entry point (Phase 14.3.5). Wires the service with
 * a provider + metrics and returns the whole Kernel Service as one factory.
 * Purely additive: nothing here is imported by a hot path, so the platform runs
 * byte-identically whether or not the lock platform is instantiated.
 *
 *   const lk = createLockPlatform({ publisher });
 *   const held = await lk.lock.tryAcquire({ namespace: 'trips', lockId: 't1', ownerId: 'svc' });
 */

const { createLockService } = require('./lockService');
const { createLockMetrics } = require('./metrics');
const providers = require('./providers');
const lockPort = require('./lockPort');
const providerPort = require('./providerPort');
const { LOCK_EVENTS } = require('../../domain/lock/events');

function createLockPlatform(deps = {}) {
  const metrics = deps.metrics || createLockMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const lock = createLockService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    sleep: deps.sleep,
    retryIntervalMs: deps.retryIntervalMs,
  });

  return { lock, provider, metrics, LOCK_EVENTS };
}

module.exports = {
  createLockPlatform,
  createLockService,
  createLockMetrics,
  providers,
  lockPort,
  providerPort,
  LOCK_EVENTS,
};
