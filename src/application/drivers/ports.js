'use strict';

const PORT_SHAPES = {
  driverRepository: [
    'findByPhone',
    'findAll',
    'findPending',
    'updateProfile',
    'setStatus',
    'setTaxiStatus',
    'setActive',
    'setApprovalStatus',
    'logApprovalAction',
    'getApprovalHistory',
    'withLock',
    'transaction',
  ],
  driverReadModel: ['findTrips', 'getStats', 'getReviews'],
  driverSessionControl: ['revokeAccess', 'revokeRefresh', 'forceDisconnect'],
  auditLog: ['info', 'warn', 'error', 'security'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Drivers ports: missing port "${name}"`);
    for (const method of methods)
      if (typeof ports[name][method] !== 'function')
        throw new Error(`Drivers ports: port "${name}" missing method "${method}"`);
  }
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
