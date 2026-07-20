'use strict';

/**
 * Trip repository adapter — Infrastructure layer.
 * Implements the tripRepository port by delegating to the existing, tested
 * TripRepository. No new persistence logic (strangler rule: wrap, don't replace).
 *
 * @param {object} deps — the existing DI service container
 */
function createTripRepositoryAdapter(deps) {
  const { tripRepo } = deps;
  return {
    findById: (id) => tripRepo.findById(id),
    findAll: (limit) => tripRepo.findAll(limit),
    findWaiting: (limit) => tripRepo.findWaiting(limit),
    findForDriver: (driverId, name, limit) => tripRepo.findForDriver(driverId, name, limit),
    findByPassenger: (phone) => tripRepo.findByPassenger(phone),
    create: (...args) => tripRepo.create(...args),
    assignDriver: (...args) => tripRepo.assignDriver(...args),
    setStatus: (id, status) => tripRepo.setStatus(id, status),
    setRejectedDrivers: (id, arr) => tripRepo.setRejectedDrivers(id, arr),
    acceptByDriver: (...args) => tripRepo.acceptByDriver(...args),
    startTrip: (id, t) => tripRepo.startTrip(id, t),
    completeTrip: (id, fare, dist, mins) => tripRepo.completeTrip(id, fare, dist, mins),
    updateLocation: (id, lat, lng, route) => tripRepo.updateLocation(id, lat, lng, route),
    rateByPassenger: (id, rating, comment) => tripRepo.rateByPassenger(id, rating, comment),
    getRatingsByDriver: (driverId) => tripRepo.getRatingsByDriver(driverId),
    rateByDriver: (id, rating, comment) => tripRepo.rateByDriver(id, rating, comment),
    deleteAll: () => tripRepo.deleteAll(),
  };
}

module.exports = { createTripRepositoryAdapter };
