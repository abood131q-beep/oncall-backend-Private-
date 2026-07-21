'use strict';

/**
 * Notification Platform — composition entry point (Phase 15.1 / ADR-030). Wires the
 * service with a store + metrics and returns the Kernel Service as one factory.
 * Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the notification kernel is instantiated. It is a
 * NEW kernel under `notifications-kernel/`; the application's existing notifications
 * bounded context is untouched.
 *
 *   const nk = createNotificationPlatform({ publisher });
 *   nk.notifications.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
 *   await nk.notifications.send({ channel: 'push', recipient: 'user-1', title: 'Hi', body: 'Ride arriving' });
 */

const { createNotificationsService } = require('./notificationsService');
const { createNotificationMetrics } = require('./metrics');
const { createMemoryStore } = require('./store');
const providers = require('./providers');
const notificationsPort = require('./notificationsPort');
const providerPort = require('./providerPort');
const { NOTIFICATION_EVENTS } = require('../../domain/notifications-kernel/events');

function createNotificationPlatform(deps = {}) {
  const metrics = deps.metrics || createNotificationMetrics({ clock: deps.clock });
  const store = deps.store || createMemoryStore();
  const notifications = createNotificationsService({
    store,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { notifications, store, metrics, NOTIFICATION_EVENTS };
}

module.exports = {
  createNotificationPlatform,
  createNotificationsService,
  createNotificationMetrics,
  createMemoryStore,
  providers,
  notificationsPort,
  providerPort,
  NOTIFICATION_EVENTS,
};
