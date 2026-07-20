'use strict';

/**
 * Scooters ports — capability contracts the Application layer depends on
 * (ADR-005 §2). Infrastructure implements; the application never knows how.
 *
 * scooterRepository (writes + atomic ops):
 *   setRiding(id, phone, startTime) → { changes }   // atomic unlock (WHERE available)
 *   createRide(id, phone, startTime) → { lastID }
 *   endRide(id, phone, endTime, durationMinutes, fare, endLat, endLng) → void
 *   setAvailable(id, newBattery, endLat, endLng, curLat, curLng) → void
 *   create(name, code, lat, lng, battery) → { lastID }
 *   remove(id) → void
 *   resetAll() → void
 *   transaction(fn) → Promise      // serialized dbTransaction (C-1 safe)
 *
 * scooterReadModel (reads / projections — Battery + GPS + Telemetry are DB fields):
 *   findAll() → row[]
 *   findById(id) → row | undefined
 *   findByIdRaw(id) → row | undefined              // full row (writes need battery/status)
 *   findActiveByPhone(phone) → row | undefined
 *   getRideHistory(phone) → row[]
 *   findUserByPhone(phone) → user | undefined
 *
 * scooterCache: get(key) / set(key, value, ttl) / clear(key)
 * walletGateway: getBalance(phone) / charge(phone, amount, description)   // reuse legacy Wallet, not migrated
 * notificationGateway: send(phone, title, body, type) → void
 * fleetGateway: bringTaxisOnline() → void                                // legacy reset side-effect
 * auditLog: info / warn / error / security
 */

const PORT_SHAPES = {
  scooterRepository: [
    'setRiding',
    'createRide',
    'endRide',
    'setAvailable',
    'create',
    'remove',
    'resetAll',
    'transaction',
  ],
  scooterReadModel: [
    'findAll',
    'findById',
    'findByIdRaw',
    'findActiveByPhone',
    'getRideHistory',
    'findUserByPhone',
  ],
  scooterCache: ['get', 'set', 'clear'],
  walletGateway: ['getBalance', 'charge'],
  notificationGateway: ['send'],
  fleetGateway: ['bringTaxisOnline'],
  auditLog: ['info', 'warn', 'error'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Scooters ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Scooters ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  if (!ports.cacheTtl || typeof ports.cacheTtl.scooters !== 'number') {
    throw new Error('Scooters ports: cacheTtl.scooters (number) is required');
  }
  if (!ports.validateCoords || typeof ports.validateCoords !== 'function') {
    throw new Error('Scooters ports: validateCoords (function) is required');
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
