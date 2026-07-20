'use strict';

/**
 * Admin ports — capability contracts the Application depends on (ADR-005 §2).
 * Infrastructure implements. The heavy SQL and system/process integrations are
 * REUSED behind these ports, never reimplemented.
 *
 * adminRepository (admin domain data — reads + writes):
 *   getStats, getDashboard, getRevenue, listUsers, getUser, toggleUserActive,
 *   listReports, resolveReport, addTaxi, deleteTaxi, listTripsPaginated,
 *   countTrips, findTrip, cancelTripByAdmin, setDriverTaxiOnline, emitTripCancelled
 * auditRepository:  getAnalytics, getSecurityEvents, getErrors, getCrashes
 * configurationRepository: getSystemInfo, getDbHealth, vacuum, reindex,
 *   listBackups, createBackup, restore
 * notificationGateway: getStats
 * loggingGateway: getLogs, clearLogs, getMetrics, scheduleShutdown
 */

const PORT_SHAPES = {
  adminRepository: [
    'getStats',
    'getDashboard',
    'getRevenue',
    'listUsers',
    'getUser',
    'toggleUserActive',
    'listReports',
    'resolveReport',
    'addTaxi',
    'deleteTaxi',
    'listTripsPaginated',
    'countTrips',
    'findTrip',
    'cancelTripByAdmin',
    'setDriverTaxiOnline',
    'emitTripCancelled',
  ],
  auditRepository: ['getAnalytics', 'getSecurityEvents', 'getErrors', 'getCrashes'],
  configurationRepository: [
    'getSystemInfo',
    'getDbHealth',
    'vacuum',
    'reindex',
    'listBackups',
    'createBackup',
    'restore',
  ],
  notificationGateway: ['getStats'],
  loggingGateway: ['getLogs', 'clearLogs', 'getMetrics', 'scheduleShutdown'],
  auditLog: ['info', 'warn', 'error'],
};

function assertPorts(ports) {
  for (const [name, methods] of Object.entries(PORT_SHAPES)) {
    if (!ports[name]) throw new Error(`Admin ports: missing port "${name}"`);
    for (const m of methods) {
      if (typeof ports[name][m] !== 'function') {
        throw new Error(`Admin ports: port "${name}" missing method "${m}"`);
      }
    }
  }
  if (typeof ports.validateCoords !== 'function')
    throw new Error('Admin ports: validateCoords required');
  return ports;
}

module.exports = { assertPorts, PORT_SHAPES };
