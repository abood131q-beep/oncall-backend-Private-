'use strict';

/**
 * Fleet ports — capability contracts the Application depends on (ADR-005 §2).
 * Infrastructure implements. The vehicle-inventory persistence + the existing
 * read cache are REUSED behind this port, never reimplemented.
 *
 * fleetRepository (the `taxis` inventory — the only capability the migrated
 *   Fleet HTTP surface exercises):
 *     listAll  → sanitized, cached vehicle list  (GET /taxis)
 *     register → insert a vehicle, returns its id (POST /admin/taxis)
 *     remove   → delete a vehicle by id           (DELETE /admin/taxis/:id)
 *
 * NOTE (scope): a Vehicle-lookup repository, a Location gateway (vehicle lat/lng
 * writes) and a Notification gateway are part of the Fleet capability map, but
 * no EXISTING Fleet HTTP endpoint exercises them — the vehicle-location writes
 * are owned/reused by the Drivers/Trips/Socket lifecycle, and Fleet has no
 * legacy notification behavior. Wiring dead adapters would introduce new
 * functionality, which this phase forbids; they are declared in the Domain
 * policies and tracked as debt for the flow-extraction phase.
 */

const PORT_SHAPES = {
  fleetRepository: ['listAll', 'register', 'remove'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Fleet ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Fleet ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  if (typeof ports.validateCoords !== 'function')
    throw new Error('Fleet ports: validateCoords required');
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
