'use strict';

/**
 * Users ports — capability contracts the Application layer depends on
 * (ADR-005 §2: the application defines contracts; Infrastructure implements).
 *
 * Contracts (duck-typed; verified at composition time by assertPorts):
 *
 * userRepository:
 *   updateName(phone, name) → Promise<user row>      // Update Profile
 *   submitReport(phone, type, description, tripId) → Promise<void>   // User Reports
 *
 * readModel (read-only projections — no write logic; Wallet stays out of scope):
 *   getBalance(phone) → Promise<{ balance } | undefined>   // User Balance (RO)
 *   getActivity(phone, limit) → Promise<object[]>          // User Activity (RO)
 *
 * notificationPreferences:
 *   list(phone, limit) → Promise<object[]>          // Notifications
 *   markAllRead(phone) → Promise<void>              // Mark read
 *
 * auditLog:
 *   info(message) / warn(message) → void
 */

const PORT_SHAPES = {
  userRepository: ['updateName', 'submitReport'],
  readModel: ['getBalance', 'getActivity'],
  notificationPreferences: ['list', 'markAllRead'],
  auditLog: ['info', 'warn'],
};

/** Fail fast at composition time if an implementation is incomplete. */
function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    const impl = ports[name];
    if (!impl) throw new Error(`Users ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof impl[m] !== 'function') {
        throw new Error(`Users ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
