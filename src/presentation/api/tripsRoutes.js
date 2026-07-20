'use strict';

/**
 * Trips routes — Presentation layer (Enterprise Architecture Migration Phase 7).
 *
 * Strangler cutover for the Trips bounded context. Legacy src/routes/taxi.js
 * remains as the instant-rollback implementation, selected via TRIPS_LEGACY=1
 * (see server.js). Paths, middleware, status codes, JSON shapes, key order, and
 * Arabic messages are byte-identical to the legacy router — proven by the live
 * A/B harness (tests/integration/trips-ab.mjs).
 *
 * Composition root: framework/adapter wiring is intentionally confined here.
 * The heavy legacy integrations (driver matcher, payment, Socket.IO, push) are
 * REUSED via infrastructure gateways, never reimplemented. Wallet/Payments/Fleet/
 * AI are NOT migrated. `/taxis` and `/places/*` are co-located non-Trips
 * passthroughs kept byte-identical, pending Fleet/Maps migration.
 */

const express = require('express');

const { createTripsApplication } = require('../../application/trips');
const {
  createTripRepositoryAdapter,
} = require('../../infrastructure/repositories/tripRepositoryAdapter');
const {
  createDriverGateway,
  createMatchingGateway,
  createCompletionGateway,
  createEventGateway,
  createFareGateway,
  createLocationGateway,
} = require('../../infrastructure/gateways/tripGateways');
const {
  createFleetReadGateway,
  createPlacesGateway,
} = require('../../infrastructure/gateways/tripCoLocatedGateways');
const { createTripsController } = require('./tripsController');

function createTripsRouter(services) {
  const app = createTripsApplication({
    tripRepository: createTripRepositoryAdapter(services),
    driverGateway: createDriverGateway(services),
    matchingGateway: createMatchingGateway(services),
    completionGateway: createCompletionGateway(services),
    eventGateway: createEventGateway(services),
    fareGateway: createFareGateway(services),
    locationGateway: createLocationGateway(services),
    auditLog: services.logger,
    formatTrip: services.formatTrip,
    safeJSON: services.safeJSON,
  });
  const coLocated = {
    fleet: createFleetReadGateway(services),
    places: createPlacesGateway(services),
  };
  const controller = createTripsController(app, services.logger, coLocated);
  const router = express.Router();
  const { authenticate, authenticateDriver, authenticatePassenger, authenticateAdmin } = services;

  // Co-located (non-Trips) — kept byte-identical
  router.get('/taxis', controller.listTaxis);
  // Trips
  router.post('/taxi/request', authenticatePassenger, controller.createTrip);
  router.post('/taxi/trips/:id/reject', authenticateDriver, controller.reject);
  router.get('/taxi/trips', authenticateDriver, controller.listDriverTrips);
  router.get('/taxi/requests', authenticateDriver, controller.listRequests);
  router.get('/taxi/trips/passenger/:phone', authenticatePassenger, controller.listPassengerTrips);
  router.put('/taxi/trips/:id/status', authenticate, controller.updateStatus);
  router.post('/taxi/trips/:id/rate', authenticatePassenger, controller.rate);
  router.post('/taxi/trips/:id/rate-passenger', authenticateDriver, controller.ratePassenger);
  router.post('/taxi/update-location', authenticateDriver, controller.updateLocation);
  router.get('/taxi/trips/:id/location', authenticate, controller.getLocation);
  router.get('/taxi/trips/:id', authenticate, controller.getTrip);
  // Co-located (non-Trips) Places proxy
  router.get('/places/autocomplete', authenticate, controller.placesAutocomplete);
  router.get('/places/details', authenticate, controller.placesDetails);
  // Admin
  router.delete('/taxi/trips', authenticateAdmin, controller.deleteAll);

  return router;
}

module.exports = { createTripsRouter };
