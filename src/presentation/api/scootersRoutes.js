'use strict';

/**
 * Scooters routes — Presentation layer (Enterprise Architecture Migration Phase 5).
 *
 * Strangler cutover for the Scooters bounded context. The legacy
 * src/routes/scooters.js remains as the instant-rollback implementation,
 * selected via SCOOTERS_LEGACY=1 (see server.js). Paths, middleware
 * (authenticate / authenticateAdmin), status codes, JSON shapes, key order,
 * and Arabic messages are byte-identical to the legacy router — proven by the
 * live A/B harness (tests/integration/scooters-ab.mjs).
 *
 * Composition root: framework/adapter wiring is intentionally confined here.
 */

const express = require('express');

const { createScootersApplication } = require('../../application/scooters');
const {
  createScooterRepositoryAdapter,
} = require('../../infrastructure/repositories/scooterRepositoryAdapter');
const {
  createScooterReadModelAdapter,
} = require('../../infrastructure/repositories/scooterReadModelAdapter');
const {
  createScooterWalletGateway,
  createScooterNotificationGateway,
  createScooterFleetGateway,
  createScooterCacheAdapter,
} = require('../../infrastructure/gateways/scooterGateways');
const { createScootersController } = require('./scootersController');

function createScootersRouter(services) {
  const app = createScootersApplication({
    scooterRepository: createScooterRepositoryAdapter(services),
    scooterReadModel: createScooterReadModelAdapter(services),
    scooterCache: createScooterCacheAdapter(services),
    walletGateway: createScooterWalletGateway(services),
    notificationGateway: createScooterNotificationGateway(services),
    fleetGateway: createScooterFleetGateway(services),
    auditLog: services.logger,
    cacheTtl: services.CACHE_TTL,
    validateCoords: services.validateCoords,
  });
  const controller = createScootersController(app, services.logger);
  const router = express.Router();
  const { authenticate, authenticateAdmin } = services;

  // Public
  router.get('/scooters', controller.list);
  router.get('/scooters/:id', controller.details);
  // Rider
  router.post('/scooter/unlock', authenticate, controller.unlock);
  router.post('/scooter/rent', controller.rentDeprecated);
  router.post('/scooter/end-ride', authenticate, controller.endRide);
  router.post('/scooter/return', controller.returnDeprecated);
  router.get('/scooter/history/:phone', authenticate, controller.history);
  router.get('/scooter/active/:phone', authenticate, controller.active);
  // Admin
  router.post('/admin/scooters', authenticateAdmin, controller.addScooter);
  router.delete('/admin/scooters/:id', authenticateAdmin, controller.deleteScooter);
  router.post('/scooters/reset', authenticateAdmin, controller.reset);

  return router;
}

module.exports = { createScootersRouter };
