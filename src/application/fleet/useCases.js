'use strict';

/**
 * Fleet use cases — Application layer (ADR-005 §5/§6).
 * Validation (domain policy) → authorization (admin gate is the middleware) →
 * orchestration via ports → typed result. A 1:1 migration of the three existing
 * Fleet endpoints co-located in the legacy Trips (`GET /taxis`) and Admin
 * (`POST /admin/taxis`, `DELETE /admin/taxis/:id`) routers. Persistence and the
 * read cache are reused behind the port, never reimplemented here.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 */

const { fleetRegistrationPolicy, FleetRejection } = require('../../domain/fleet/fleetPolicies');
const { newVehicle } = require('../../domain/fleet/Fleet');

const FleetError = Object.freeze({ ...FleetRejection });

function createFleetUseCases(ports) {
  const { fleetRepository, validateCoords } = ports;

  // GET /taxis — sanitized, cached list (cache handled in the adapter, verbatim).
  async function listVehicles() {
    return { ok: true, value: await fleetRepository.listAll() };
  }

  // POST /admin/taxis — validate (name + coords, Kuwait default), insert, return id.
  async function registerVehicle(command) {
    const gate = fleetRegistrationPolicy(command.name, command.lat, command.lng, validateCoords);
    if (!gate.allowed) return { ok: false, code: gate.code };
    const persisted = newVehicle(gate);
    const id = await fleetRepository.register(persisted.name, persisted.lat, persisted.lng);
    return { ok: true, value: { id } };
  }

  // DELETE /admin/taxis/:id — remove by id (legacy is unconditional; no 404).
  async function removeVehicle(command) {
    await fleetRepository.remove(command.id);
    return { ok: true, value: {} };
  }

  return { listVehicles, registerVehicle, removeVehicle };
}

module.exports = { createFleetUseCases, FleetError };
