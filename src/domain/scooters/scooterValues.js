'use strict';

/**
 * Scooters domain — Value Objects (ADR-002 §7, ADR-005 §18).
 *
 * Pure: no I/O, no framework, no SQL, no Socket.IO. Behavior is a 1:1
 * extraction of the constants and shapes used by the legacy
 * src/routes/scooters.js. Any change is an ADR amendment, not an edit here.
 */

// ── Business constants (from legacy scooters route) ──────────────────────────
const MIN_UNLOCK_BALANCE = 0.5; // د.ك — minimum wallet to unlock
const MIN_UNLOCK_BATTERY = 10; // % — below this, unlock is refused
const FARE_PER_MINUTE = 0.05; // د.ك/min
const MIN_FARE = 0.5; // د.ك — floor
const BATTERY_FLOOR = 5; // % — battery never modeled below this
const BATTERY_DRAIN_PER_MIN = 0.5; // % per minute of ride

/** ScooterStatus — the lifecycle states a scooter can hold (legacy values). */
const ScooterStatus = Object.freeze({
  AVAILABLE: 'available',
  RIDING: 'riding',
});

/** BatteryLevel — a validated 0..100 integer percentage. */
function batteryLevel(raw) {
  const n = Number(raw);
  const valid = Number.isFinite(n) && n >= 0 && n <= 100;
  return { valid, value: valid ? n : null };
}

/** Is the battery high enough to permit an unlock? */
function batteryPermitsUnlock(battery) {
  return Number(battery) >= MIN_UNLOCK_BATTERY;
}

/** ScooterCode — the human/QR identifier; passthrough (legacy adds no validation). */
function scooterCode(raw) {
  return raw == null ? undefined : String(raw);
}

/** Availability — derived from status. */
function isAvailable(status) {
  return status === ScooterStatus.AVAILABLE;
}

module.exports = {
  ScooterStatus,
  batteryLevel,
  batteryPermitsUnlock,
  scooterCode,
  isAvailable,
  MIN_UNLOCK_BALANCE,
  MIN_UNLOCK_BATTERY,
  FARE_PER_MINUTE,
  MIN_FARE,
  BATTERY_FLOOR,
  BATTERY_DRAIN_PER_MIN,
};
