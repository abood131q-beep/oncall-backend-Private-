'use strict';

/**
 * Scooters domain — Policies (ADR-002 §5, ADR-005 §1).
 *
 * The invariants; the Application layer asks, this module decides. Pure: no
 * I/O, no framework, no SQL. Every decision is a 1:1 extraction of the legacy
 * src/routes/scooters.js logic — outcomes and ordering preserved exactly.
 */

const {
  ScooterStatus,
  batteryPermitsUnlock,
  isAvailable,
  MIN_UNLOCK_BALANCE,
  FARE_PER_MINUTE,
  MIN_FARE,
  BATTERY_FLOOR,
  BATTERY_DRAIN_PER_MIN,
} = require('./scooterValues');

/** Outcome codes shared with the Application layer. */
const ScooterRejection = Object.freeze({
  SCOOTER_NOT_FOUND: 'SCOOTER_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  LOW_BATTERY: 'LOW_BATTERY',
  UNLOCK_RACE_LOST: 'UNLOCK_RACE_LOST',
  NOT_YOUR_SCOOTER: 'NOT_YOUR_SCOOTER',
  INVALID_COORDS: 'INVALID_COORDS',
});

/**
 * UnlockPolicy — ordered exactly as legacy: available → balance → battery.
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
function unlockPolicy(scooter, userBalance) {
  if (!isAvailable(scooter.status)) {
    return { allowed: false, code: ScooterRejection.NOT_AVAILABLE };
  }
  if (Number(userBalance) < MIN_UNLOCK_BALANCE) {
    return { allowed: false, code: ScooterRejection.INSUFFICIENT_BALANCE };
  }
  if (!batteryPermitsUnlock(scooter.battery)) {
    return { allowed: false, code: ScooterRejection.LOW_BATTERY };
  }
  return { allowed: true };
}

/**
 * LockPolicy (end-ride ownership) — only the current rider may end the ride.
 * Mirrors: `if (scooter.current_user_phone !== phone) → 403`.
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
function lockPolicy(scooter, actorPhone) {
  if (scooter.current_user_phone !== actorPhone) {
    return { allowed: false, code: ScooterRejection.NOT_YOUR_SCOOTER };
  }
  return { allowed: true };
}

/** AvailabilityPolicy — is this scooter rentable right now? */
function availabilityPolicy(scooter) {
  return { available: isAvailable(scooter.status) };
}

/**
 * Ride settlement (fare/battery/duration) — pure computation extracted from
 * end-ride. Durations in ms; returns the exact legacy numbers.
 */
function settleRide(startTime, endTime, currentBattery) {
  const durationMinutes = Math.max(1, Math.round((endTime - startTime) / 60000));
  const fare = Math.max(MIN_FARE, Math.round(durationMinutes * FARE_PER_MINUTE * 1000) / 1000);
  const batteryUsed = Math.min(
    currentBattery - BATTERY_FLOOR,
    Math.round(durationMinutes * BATTERY_DRAIN_PER_MIN)
  );
  const newBattery = Math.max(BATTERY_FLOOR, currentBattery - batteryUsed);
  return { durationMinutes, fare, newBattery };
}

/**
 * Live fare (active ride) — legacy `active` endpoint: no minimum-1 on duration.
 */
function liveFare(startTime, now) {
  const durationMinutes = Math.round((now - startTime) / 60000);
  const currentFare = Math.max(
    MIN_FARE,
    Math.round(durationMinutes * FARE_PER_MINUTE * 1000) / 1000
  );
  return { durationMinutes, currentFare };
}

module.exports = {
  ScooterRejection,
  ScooterStatus,
  unlockPolicy,
  lockPolicy,
  availabilityPolicy,
  settleRide,
  liveFare,
};
