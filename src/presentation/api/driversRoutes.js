'use strict';

const express = require('express');
const { createDriversApplication } = require('../../application/drivers');
const {
  createDriverRepositoryAdapter,
} = require('../../infrastructure/repositories/driverRepositoryAdapter');
const {
  createDriverReadModelAdapter,
} = require('../../infrastructure/repositories/driverReadModelAdapter');
const {
  createDriverSessionControlAdapter,
} = require('../../infrastructure/gateways/driverSessionControlAdapter');
const { createDriversController } = require('./driversController');

/** Composition root: framework/adapter wiring is intentionally confined here. */
function createDriversRouter(services) {
  const app = createDriversApplication({
    driverRepository: createDriverRepositoryAdapter(services),
    driverReadModel: createDriverReadModelAdapter(services),
    driverSessionControl: createDriverSessionControlAdapter(services),
    auditLog: services.logger,
  });
  const controller = createDriversController(app, services.logger, services.formatTrip);
  const router = express.Router();
  const { authenticateDriver, authenticateAdmin } = services;

  router.post('/driver/status', authenticateDriver, controller.changeAvailability);
  router.get('/driver/info/:phone', authenticateDriver, controller.getProfile);
  router.post('/driver/update', authenticateDriver, controller.updateProfile);
  router.get('/driver/trips/:phone', authenticateDriver, controller.getTrips);
  router.get('/driver/stats/:phone', authenticateDriver, controller.getStats);
  router.get('/driver/reviews/:phone', authenticateDriver, controller.getReviews);

  // Registered before legacy admin.js. Same public paths; legacy remains rollback.
  router.get('/admin/drivers', authenticateAdmin, controller.listDrivers);
  router.get('/admin/drivers/pending', authenticateAdmin, controller.listPending);
  router.get(
    '/admin/drivers/:phone/approval-history',
    authenticateAdmin,
    controller.approvalHistory
  );
  router.get('/admin/drivers/:phone', authenticateAdmin, controller.getDriver);
  router.put('/admin/drivers/:phone/toggle', authenticateAdmin, controller.toggleDriver);
  router.put(
    '/admin/drivers/:phone/approve',
    authenticateAdmin,
    controller.transition('approveDriver', 'approveDriverCommand')
  );
  router.put(
    '/admin/drivers/:phone/reject',
    authenticateAdmin,
    controller.transition('rejectDriver', 'rejectDriverCommand')
  );
  router.put(
    '/admin/drivers/:phone/suspend',
    authenticateAdmin,
    controller.transition('suspendDriver', 'suspendDriverCommand')
  );
  router.put(
    '/admin/drivers/:phone/reactivate',
    authenticateAdmin,
    controller.transition('reactivateDriver', 'reactivateDriverCommand')
  );
  return router;
}
module.exports = { createDriversRouter };
