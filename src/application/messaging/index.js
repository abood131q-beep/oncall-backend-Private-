'use strict';

/**
 * Messaging Platform — composition entry point (Phase 14.5 / ADR-024). Wires the
 * service with a provider + metrics and returns the Kernel Service as one
 * factory. Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not messaging is instantiated.
 *
 *   const mq = createMessagingPlatform({ publisher });
 *   const sub = mq.messaging.subscribe({ topic: 'trips', handler: (m) => {...} });
 *   await mq.messaging.publish({ topic: 'trips', payload: { id: 1 } });
 */

const { createMessagingService } = require('./messagingService');
const { createMessagingMetrics } = require('./metrics');
const providers = require('./providers');
const messagingPort = require('./messagingPort');
const providerPort = require('./providerPort');
const { MESSAGING_EVENTS } = require('../../domain/messaging/events');

function createMessagingPlatform(deps = {}) {
  const metrics = deps.metrics || createMessagingMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const messaging = createMessagingService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    sleep: deps.sleep,
    setTimeoutImpl: deps.setTimeoutImpl,
    clearTimeoutImpl: deps.clearTimeoutImpl,
    retryPolicy: deps.retryPolicy,
  });
  return { messaging, provider, metrics, MESSAGING_EVENTS };
}

module.exports = {
  createMessagingPlatform,
  createMessagingService,
  createMessagingMetrics,
  providers,
  messagingPort,
  providerPort,
  MESSAGING_EVENTS,
};
