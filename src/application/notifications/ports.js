'use strict';

/**
 * Notifications ports — capability contracts the Application layer depends on
 * (ADR-005 §2). Infrastructure implements; the application never knows how.
 *
 * deviceTokenRepository:
 *   upsert(phone, token, platform, appVersion) → void   // INSERT ... ON CONFLICT
 *   findOne(phone, token) → row | undefined
 *   remove(phone, token) → void
 *   listForPhone(phone) → row[]                          // diagnostics (admin)
 *
 * pushGateway (reuse existing notification service — production behavior):
 *   send(phone, title, body, data) → result
 *   broadcast(phones, title, body, data) → result
 *
 * auditLog: info / warn / error
 */

const PORT_SHAPES = {
  deviceTokenRepository: ['upsert', 'findOne', 'remove', 'listForPhone'],
  pushGateway: ['send', 'broadcast'],
  auditLog: ['info', 'warn', 'error'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Notifications ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Notifications ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
