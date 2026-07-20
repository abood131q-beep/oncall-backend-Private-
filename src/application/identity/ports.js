'use strict';

/**
 * Identity ports — capability contracts the Application layer depends on
 * (ADR-005 §2: the application defines contracts; Infrastructure implements).
 *
 * Contracts (duck-typed; verified at composition time by assertPorts):
 *
 * identityRepository:
 *   findUserByPhone(phone) → user | undefined
 *   createUser(phone, name) → user
 *   findDriverByPhone(phone) → driver | undefined
 *   createDriver(phone) → driver
 *   setDriverPresence(phone, driverId, status) → void   // status: 'offline'
 *   recordLoginLog(phone, type, ip) → void (fire-and-forget, never throws)
 *
 * tokenGateway:
 *   issueAccessToken(payload) → string
 *   issueRefreshToken(payload) → Promise<string>
 *   verifyRefreshToken(token) → Promise<payload | null>
 *   revokeRefreshToken(token) → Promise<void>
 *   revokeAllRefreshTokens(phone) → Promise<void>
 *   verifyAccessToken(token) → payload | null
 *   revokeAccessTokens(phone) → void
 *
 * otpGateway:
 *   isRequired() → boolean
 *   send(phone, ctx) → Promise<void>
 *   verify(phone, code, ctx) → Promise<boolean>
 *
 * auditLog:
 *   info(message) / warn(message) / security(kind, details) → void
 */

const PORT_SHAPES = {
  identityRepository: [
    'findUserByPhone',
    'createUser',
    'findDriverByPhone',
    'createDriver',
    'setDriverPresence',
    'recordLoginLog',
  ],
  tokenGateway: [
    'issueAccessToken',
    'issueRefreshToken',
    'verifyRefreshToken',
    'revokeRefreshToken',
    'revokeAllRefreshTokens',
    'verifyAccessToken',
    'revokeAccessTokens',
  ],
  otpGateway: ['isRequired', 'send', 'verify'],
  auditLog: ['info', 'warn', 'security'],
};

/** Fail fast at composition time if an implementation is incomplete. */
function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    const impl = ports[name];
    if (!impl) throw new Error(`Identity ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof impl[m] !== 'function') {
        throw new Error(`Identity ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  if (!Array.isArray(ports.adminPhones)) {
    throw new Error('Identity ports: adminPhones (string[]) is required');
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
