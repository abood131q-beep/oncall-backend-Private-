'use strict';

/**
 * Fleet domain — Policies (ADR-002 §5, ADR-005 §1).
 * The invariants of the vehicle inventory; the Application asks, this module
 * decides. Pure: no I/O, no framework, no SQL. Every decision is a 1:1
 * extraction of a rule that already lives in the legacy platform (admin taxi
 * registration validation + the `GET /taxis` sanitized projection + the
 * online⇒assignable semantics used by the matcher). No new rule is introduced.
 */

const {
  VehicleStatus,
  FleetAvailability,
  availabilityOf,
  DEFAULT_LAT,
  DEFAULT_LNG,
  PUBLIC_FIELDS,
} = require('./fleetValues');

const FleetRejection = Object.freeze({
  VEHICLE_NAME_REQUIRED: 'VEHICLE_NAME_REQUIRED',
  BAD_COORDS: 'BAD_COORDS',
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
});

/**
 * FleetRegistrationPolicy — a vehicle needs a name; coordinates are validated,
 * defaulting to Kuwait when omitted (verbatim legacy `POST /admin/taxis`).
 * @param {Function} validateCoords injected pure predicate (existing integration)
 */
function fleetRegistrationPolicy(name, lat, lng, validateCoords) {
  if (!name || !String(name).trim()) {
    return { allowed: false, code: FleetRejection.VEHICLE_NAME_REQUIRED };
  }
  const parsedLat = lat != null ? parseFloat(lat) : DEFAULT_LAT;
  const parsedLng = lng != null ? parseFloat(lng) : DEFAULT_LNG;
  if (!validateCoords(parsedLat, parsedLng)) {
    return { allowed: false, code: FleetRejection.BAD_COORDS };
  }
  return { allowed: true, name: String(name).trim(), lat: parsedLat, lng: parsedLng };
}

/**
 * FleetValidationPolicy — the public projection of a vehicle row. Exactly the
 * legacy `sanitizeTaxi` shape ({id,name,lat,lng,status}); no other column leaks.
 */
function fleetValidationPolicy(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = row[f];
  return out;
}

/**
 * FleetAvailabilityPolicy — read-only availability class of a vehicle
 * (online⇒available, busy⇒busy, else offline). Pure derivation of existing
 * status semantics; exposed for the Fleet read model, adds no endpoint.
 */
function fleetAvailabilityPolicy(status) {
  return { status, availability: availabilityOf(status) };
}

/**
 * FleetAssignmentPolicy — a vehicle may be assigned to a trip only while online
 * (the precondition the matcher already enforces before flipping it to busy).
 * Pure; the actual assignment writes remain owned/reused by the Trips context.
 */
function fleetAssignmentPolicy(status) {
  return { allowed: status === VehicleStatus.ONLINE };
}

module.exports = {
  FleetRejection,
  FleetAvailability,
  fleetRegistrationPolicy,
  fleetValidationPolicy,
  fleetAvailabilityPolicy,
  fleetAssignmentPolicy,
};
