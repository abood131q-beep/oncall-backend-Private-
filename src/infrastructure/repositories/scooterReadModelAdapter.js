'use strict';

/**
 * Scooter read-model adapter — Infrastructure layer (ADR-004 read models).
 * Read-only projections over the existing ScooterRepository. Battery, GPS
 * (lat/lng) and telemetry are persisted scooter fields in this platform — there
 * is no separate live IoT integration in the legacy system — so the "Battery /
 * GPS / Telemetry" adapters collapse into these repository-backed reads rather
 * than inventing infrastructure that does not exist (scope: existing only).
 *
 * @param {object} deps — the existing DI service container
 */
function createScooterReadModelAdapter(deps) {
  const { scooterRepo, userRepo } = deps;

  return {
    findAll: () => scooterRepo.findAll(),
    findById: (id) => scooterRepo.findById(id),
    findByIdRaw: (id) => scooterRepo.findById(id), // full row (battery/status/name/GPS)
    findActiveByPhone: (phone) => scooterRepo.findActiveByPhone(phone),
    getRideHistory: (phone) => scooterRepo.getRideHistory(phone),
    // Balance read for the unlock gate — reuse existing user store (Wallet not migrated).
    findUserByPhone: (phone) => userRepo.findByPhone(phone),
  };
}

module.exports = { createScooterReadModelAdapter };
