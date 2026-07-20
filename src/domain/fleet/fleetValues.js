'use strict';

/**
 * Fleet domain — Value Objects (ADR-002 §4).
 * Pure vocabulary for the vehicle inventory (the legacy `taxis` table). No I/O,
 * no framework, no SQL. Encodes only semantics that ALREADY exist in the legacy
 * platform (status values written across the driver/trip lifecycle, the Kuwait
 * default coordinates used by admin taxi registration, and the exact public
 * field projection returned by `GET /taxis`).
 */

/** VehicleStatus — the status values the `taxis` row actually takes at runtime. */
const VehicleStatus = Object.freeze({
  ONLINE: 'online', // available for assignment
  BUSY: 'busy', // currently on a trip
  OFFLINE: 'offline', // not working
});

const VEHICLE_STATUSES = Object.freeze(Object.values(VehicleStatus));

function isVehicleStatus(v) {
  return VEHICLE_STATUSES.includes(v);
}

/** FleetAvailability — derived, read-only availability of a single vehicle. */
const FleetAvailability = Object.freeze({
  AVAILABLE: 'available',
  BUSY: 'busy',
  OFFLINE: 'offline',
});

/** Map a raw status to its availability class (legacy semantics: online⇒available). */
function availabilityOf(status) {
  if (status === VehicleStatus.ONLINE) return FleetAvailability.AVAILABLE;
  if (status === VehicleStatus.BUSY) return FleetAvailability.BUSY;
  return FleetAvailability.OFFLINE;
}

/** VehicleId — normalize an inbound identifier (path param) without asserting existence. */
function VehicleId(raw) {
  return raw == null ? null : String(raw);
}

// Kuwait default coordinates — the legacy fallback used when admin omits lat/lng.
const DEFAULT_LAT = 29.3765;
const DEFAULT_LNG = 47.9785;

// The exact fields exposed by the public `GET /taxis` contract (sanitized view).
const PUBLIC_FIELDS = Object.freeze(['id', 'name', 'lat', 'lng', 'status']);

// The status a newly-registered vehicle receives (legacy admin INSERT default).
const REGISTERED_STATUS = VehicleStatus.ONLINE;

module.exports = {
  VehicleStatus,
  VEHICLE_STATUSES,
  isVehicleStatus,
  FleetAvailability,
  availabilityOf,
  VehicleId,
  DEFAULT_LAT,
  DEFAULT_LNG,
  PUBLIC_FIELDS,
  REGISTERED_STATUS,
};
