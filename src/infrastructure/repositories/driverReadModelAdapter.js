'use strict';

/** Read-only Driver projections. Trips remain owned by the Trips context. */
function createDriverReadModelAdapter(deps) {
  const { tripRepo, driverRepo } = deps;
  return {
    findTrips: (driverId, driverName, limit) => tripRepo.findByDriver(driverId, driverName, limit),
    getStats: (driverId) => tripRepo.getStats(driverId),
    getReviews: (driverId) => driverRepo.getReviews(driverId),
  };
}
module.exports = { createDriverReadModelAdapter };
