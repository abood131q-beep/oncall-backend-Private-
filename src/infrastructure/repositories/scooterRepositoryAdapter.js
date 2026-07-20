'use strict';

/**
 * Scooter repository adapter — Infrastructure layer.
 * Implements the scooterRepository port (writes + atomic ops) by delegating to
 * the existing, tested ScooterRepository and the serialized `dbTransaction`.
 * No new persistence logic is introduced (strangler rule: wrap, don't replace).
 *
 * @param {object} deps — the existing DI service container (server.js `services`)
 */
function createScooterRepositoryAdapter(deps) {
  const { scooterRepo, dbTransaction } = deps;

  return {
    setRiding: (id, phone, startTime) => scooterRepo.setRiding(id, phone, startTime),
    createRide: (id, phone, startTime) => scooterRepo.createRide(id, phone, startTime),
    endRide: (id, phone, endTime, durationMinutes, fare, endLat, endLng) =>
      scooterRepo.endRideRecord(id, phone, endTime, durationMinutes, fare, endLat, endLng),
    setAvailable: (id, newBattery, endLat, endLng, curLat, curLng) =>
      scooterRepo.setAvailable(id, newBattery, endLat, endLng, curLat, curLng),
    create: (name, code, lat, lng, battery) => scooterRepo.create(name, code, lat, lng, battery),
    remove: (id) => scooterRepo.delete(id),
    resetAll: () => scooterRepo.resetAll(),
    // Serialized transaction boundary (C-1 safe) — same helper the legacy route now uses.
    transaction: (fn) => dbTransaction(fn),
  };
}

module.exports = { createScooterRepositoryAdapter };
