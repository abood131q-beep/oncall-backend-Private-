'use strict';

/**
 * Notifications routes — Presentation layer (Enterprise Architecture Migration Phase 6).
 *
 * Strangler cutover for the Notifications bounded context (device tokens + push
 * dispatch). Legacy src/routes/notifications.js remains as the instant-rollback
 * implementation, selected via NOTIFICATIONS_LEGACY=1 (see server.js). Paths,
 * middleware (authenticate / authenticateAdmin), status codes, JSON shapes, key
 * order, and Arabic messages are byte-identical to the legacy router — proven by
 * the live A/B harness (tests/integration/notifications-ab.mjs).
 *
 * Composition root: framework/adapter wiring is intentionally confined here.
 */

const express = require('express');

const { createNotificationsApplication } = require('../../application/notifications');
const {
  createDeviceTokenAdapter,
} = require('../../infrastructure/repositories/deviceTokenAdapter');
const { createPushGatewayAdapter } = require('../../infrastructure/gateways/pushGatewayAdapter');
const { createNotificationsController } = require('./notificationsController');

function createNotificationsRouter(services) {
  const app = createNotificationsApplication({
    deviceTokenRepository: createDeviceTokenAdapter(services),
    pushGateway: createPushGatewayAdapter(services),
    auditLog: services.logger,
  });
  const controller = createNotificationsController(app, services.logger);
  const router = express.Router();
  const { authenticate, authenticateAdmin } = services;

  router.post('/device-tokens', authenticate, controller.register);
  router.delete('/device-tokens', authenticate, controller.remove);
  router.post('/push/send', authenticateAdmin, controller.pushSend);
  router.post('/push/broadcast', authenticateAdmin, controller.pushBroadcast);
  router.get('/device-tokens/:phone', authenticateAdmin, controller.listTokens);

  return router;
}

module.exports = { createNotificationsRouter };
