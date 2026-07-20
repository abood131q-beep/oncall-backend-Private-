'use strict';

/**
 * Fleet routes — Presentation layer (Enterprise Architecture Migration Phase 9).
 *
 * Strangler cutover for the Fleet bounded context. The three existing Fleet
 * endpoints were co-located inside the legacy Trips (`GET /taxis`) and Admin
 * (`POST /admin/taxis`, `DELETE /admin/taxis/:id`) routers; this router now
 * OWNS them. It is mounted BEFORE the Trips and Admin routers, so first-match
 * makes it the sole active owner. FLEET_LEGACY=1 removes it (see server.js), and
 * the still-mounted co-located handlers resume serving — immediate rollback.
 * Paths, middleware, status codes, JSON shapes, key order, and Arabic messages
 * are byte-identical to the legacy handlers — proven by tests/integration/
 * fleet-ab.mjs.
 *
 * SCOPE (frozen): only the pre-existing Fleet HTTP surface (list / register /
 * remove a vehicle). The vehicle-status/location writes performed across the
 * driver & trip & scooter & socket lifecycle are NOT Fleet endpoints and remain
 * reused-in-place unchanged. Wallet/Payments/AI are NOT migrated. No new Fleet
 * capability is introduced.
 *
 * Composition root: framework/adapter wiring is intentionally confined here. The
 * `taxis` persistence and the existing read cache are REUSED via the adapter,
 * never reimplemented.
 */

const express = require('express');

const { createFleetApplication } = require('../../application/fleet');
const {
  createFleetRepositoryAdapter,
} = require('../../infrastructure/repositories/fleetRepositoryAdapter');
const { createFleetController } = require('./fleetController');

function createFleetRouter(services) {
  const app = createFleetApplication({
    fleetRepository: createFleetRepositoryAdapter(services),
    validateCoords: services.validateCoords,
  });

  const c = createFleetController(app);
  const router = express.Router();
  const { authenticateAdmin } = services;

  // Public fleet lookup / availability (no auth — legacy contract).
  router.get('/taxis', c.listVehicles);

  // Fleet administration (admin-gated — legacy contract).
  router.post('/admin/taxis', authenticateAdmin, c.registerVehicle);
  router.delete('/admin/taxis/:id', authenticateAdmin, c.removeVehicle);

  return router;
}

module.exports = { createFleetRouter };
