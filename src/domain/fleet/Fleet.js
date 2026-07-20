'use strict';

/**
 * Fleet domain — Vehicle aggregate (ADR-002 §3).
 * A thin, pure representation of a fleet vehicle (the legacy `taxis` row). Holds
 * no framework/SQL; exposes the sanitized public projection and the derived
 * availability. Reconstitution never asserts persistence — that is the
 * repository's concern (ADR-005). No behavior beyond what the legacy platform
 * already exhibits.
 */

const { availabilityOf, REGISTERED_STATUS } = require('./fleetValues');
const { fleetValidationPolicy } = require('./fleetPolicies');

/** Reconstitute a vehicle from a persisted row (read side). */
function reconstituteVehicle(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    publicView: () => fleetValidationPolicy(row),
    availability: () => availabilityOf(row.status),
  });
}

/**
 * Build the persistable shape for a newly-registered vehicle (write side).
 * Mirrors the legacy admin INSERT: name/lat/lng validated upstream by the
 * FleetRegistrationPolicy, status defaults to online.
 */
function newVehicle({ name, lat, lng }) {
  return Object.freeze({ name, lat, lng, status: REGISTERED_STATUS });
}

module.exports = { reconstituteVehicle, newVehicle };
