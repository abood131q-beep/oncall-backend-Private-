'use strict';

/**
 * Trips ports — capability contracts the Application layer depends on
 * (ADR-005 §2). Infrastructure implements; the application never knows how.
 * The heavy legacy integrations (driver matcher, payment, Socket.IO events,
 * push notifications) are REUSED behind these ports, never reimplemented.
 *
 * tripRepository: findById, findAll, findWaiting, findForDriver, findByPassenger,
 *   create, assignDriver, setStatus, setRejectedDrivers, acceptByDriver,
 *   startTrip, completeTrip, updateLocation, rateByPassenger, getRatingsByDriver,
 *   rateByDriver, deleteAll
 * driverGateway: findByPhone, findById, findTaxi, setTaxiBusy, resetTaxiOnline, updateRating
 * matchingGateway: findNearestDriver, sendRequestToDriver, clearTimer
 * completionGateway: settle(tripId, trip, finalFare)   // C-1 tx: payment(reused)+status+notif
 * eventGateway: statusUpdated, noDriver, accepted, driverMoved, pushStatusChange, tripNotify
 * fareGateway: estimate, calculate, distanceKm, validateCoords
 * locationGateway: updateTaxiLocation, resetTaxis
 * auditLog: info, warn, error, success
 */

const PORT_SHAPES = {
  tripRepository: [
    'findById',
    'findAll',
    'findWaiting',
    'findForDriver',
    'findByPassenger',
    'create',
    'assignDriver',
    'setStatus',
    'setRejectedDrivers',
    'acceptByDriver',
    'startTrip',
    'completeTrip',
    'updateLocation',
    'rateByPassenger',
    'getRatingsByDriver',
    'rateByDriver',
    'deleteAll',
  ],
  driverGateway: [
    'findByPhone',
    'findById',
    'findTaxi',
    'setTaxiBusy',
    'resetTaxiOnline',
    'updateRating',
  ],
  matchingGateway: ['findNearestDriver', 'sendRequestToDriver', 'clearTimer'],
  completionGateway: ['settle'],
  eventGateway: [
    'statusUpdated',
    'noDriver',
    'accepted',
    'driverMoved',
    'pushStatusChange',
    'tripNotify',
  ],
  fareGateway: ['estimate', 'calculate', 'distanceKm', 'validateCoords'],
  locationGateway: ['updateTaxiLocation', 'resetTaxis'],
  auditLog: ['info', 'warn', 'error'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Trips ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Trips ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  for (const fn of ['formatTrip', 'safeJSON']) {
    if (typeof ports[fn] !== 'function')
      throw new Error(`Trips ports: "${fn}" (function) is required`);
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
