'use strict';

/**
 * Identity repository adapter — Infrastructure layer.
 * Implements the identityRepository port (application/identity/ports.js) by
 * delegating to the existing, tested repository factories and helpers.
 * No new persistence logic is introduced in Phase 1 (strangler rule:
 * wrap first, extract later).
 *
 * @param {object} deps — the existing DI service container (server.js `services`)
 */
function createIdentityRepositoryAdapter(deps) {
  const { userRepo, driverRepo, dbRun } = deps;

  return {
    findUserByPhone: (phone) => userRepo.findByPhone(phone),
    createUser: (phone, name) => userRepo.create(phone, name),
    findDriverByPhone: (phone) => driverRepo.findByPhone(phone),
    createDriver: (phone) => driverRepo.create(phone),

    async setDriverPresence(phone, driverId, status) {
      await driverRepo.setStatus(phone, status);
      await driverRepo.setTaxiStatus(driverId, status);
    },

    // Fire-and-forget by contract (legacy behavior): login must not fail
    // because the log write failed.
    recordLoginLog(phone, type, ip) {
      dbRun('INSERT INTO login_logs (phone, type, ip) VALUES (?, ?, ?)', [phone, type, ip]).catch(
        () => {}
      );
    },
  };
}

module.exports = { createIdentityRepositoryAdapter };
