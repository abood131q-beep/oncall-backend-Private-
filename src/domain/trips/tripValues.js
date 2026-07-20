'use strict';

/**
 * Trips domain — Value Objects (ADR-002 §7, ADR-005 §18).
 *
 * Pure: no I/O, no framework, no SQL, no Socket.IO. Constants and shapes are a
 * 1:1 extraction of the legacy src/routes/taxi.js. Any change is an ADR
 * amendment, not an edit here.
 */

// ── TripStatus VO ─────────────────────────────────────────────────────────────
const VALID_STATUSES = [
  'waiting_driver',
  'accepted',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
];
const DRIVER_ONLY_STATUSES = ['accepted', 'arrived', 'in_progress', 'completed'];
const CANCELLABLE_STATUSES = ['waiting_driver', 'accepted', 'arrived', 'in_progress'];

const TripStatus = Object.freeze({
  WAITING: 'waiting_driver',
  ACCEPTED: 'accepted',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_DRIVER: 'no_driver',
});

function isValidStatus(status) {
  return VALID_STATUSES.includes(status);
}
function isDriverOnly(status) {
  return DRIVER_ONLY_STATUSES.includes(status);
}
function isCancellable(currentStatus) {
  return CANCELLABLE_STATUSES.includes(currentStatus);
}

// ── TripId VO ─────────────────────────────────────────────────────────────────
function tripId(raw) {
  const n = Number(raw);
  return { valid: Number.isFinite(n), value: n };
}

// ── PickupLocation / DestinationLocation VOs ─────────────────────────────────
// Legacy validates coords only when provided (validateCoords injected as a port).
function location(text, lat, lng) {
  return { text, lat, lng, hasCoords: lat != null && lng != null };
}

module.exports = {
  VALID_STATUSES,
  DRIVER_ONLY_STATUSES,
  CANCELLABLE_STATUSES,
  TripStatus,
  isValidStatus,
  isDriverOnly,
  isCancellable,
  tripId,
  location,
};
