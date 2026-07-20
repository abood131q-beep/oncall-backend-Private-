'use strict';

/**
 * Admin use cases — Application layer (ADR-005 §5/§6).
 * Validation (domain policy) → authorization (admin gate is the middleware) →
 * orchestration via ports → typed result. A 1:1 migration of the general admin
 * endpoints in src/routes/admin.js. The SQL and system integrations are reused
 * behind the ports, never reimplemented here.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 */

const {
  AdminRejection,
  normalizePagination,
  clampN,
  restorePolicy,
  shutdownPolicy,
  taxiCreationPolicy,
  toggleActive,
} = require('../../domain/admin/adminPolicies');

const AdminError = Object.freeze({ ...AdminRejection });

function createAdminUseCases(ports) {
  const {
    adminRepository,
    auditRepository,
    configurationRepository,
    notificationGateway,
    loggingGateway,
    validateCoords,
  } = ports;

  // ── Reads (thin projections) ────────────────────────────────────────────────
  const stats = async () => ({ ok: true, value: await adminRepository.getStats() });
  const dashboard = async () => ({ ok: true, value: await adminRepository.getDashboard() });
  const revenue = async () => ({ ok: true, value: await adminRepository.getRevenue() });
  const listUsers = async () => ({ ok: true, value: await adminRepository.listUsers() });
  const listReports = async () => ({ ok: true, value: await adminRepository.listReports() });
  const analytics = async (c) => ({
    ok: true,
    value: await auditRepository.getAnalytics(c.period),
  });
  const backups = async () => ({ ok: true, value: await configurationRepository.listBackups() });
  const systemInfo = async () => ({
    ok: true,
    value: await configurationRepository.getSystemInfo(),
  });
  const dbHealth = async () => ({ ok: true, value: await configurationRepository.getDbHealth() });
  const metrics = async () => ({ ok: true, value: await loggingGateway.getMetrics() });
  const securityEvents = async (c) => ({
    ok: true,
    value: await auditRepository.getSecurityEvents(clampN(c.n, 50, 200)),
  });
  const errors = async (c) => ({
    ok: true,
    value: await auditRepository.getErrors(clampN(c.n, 100, 200)),
  });
  const crashes = async (c) => ({
    ok: true,
    value: await auditRepository.getCrashes(clampN(c.n, 20, 50)),
  });
  const notificationStats = async () => ({ ok: true, value: await notificationGateway.getStats() });
  const logs = async (c) => ({
    ok: true,
    value: await loggingGateway.getLogs(parseInt(c.n, 10) || 50, c.level),
  });

  async function getUser(command) {
    const user = await adminRepository.getUser(command.phone);
    if (!user) return { ok: false, code: AdminError.USER_NOT_FOUND };
    return { ok: true, value: { user } };
  }

  async function listTrips(command) {
    const { page, limit } = normalizePagination(command.page, command.limit);
    const trips = await adminRepository.listTripsPaginated(page, limit, command.status);
    const total = await adminRepository.countTrips(command.status);
    return {
      ok: true,
      value: { trips, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    };
  }

  // ── Writes / maintenance ────────────────────────────────────────────────────
  async function toggleUser(command) {
    const user = await adminRepository.getUser(command.phone);
    if (!user) return { ok: false, code: AdminError.USER_NOT_FOUND };
    const newStatus = toggleActive(user.is_active);
    await adminRepository.toggleUserActive(command.phone, newStatus);
    return { ok: true, value: { is_active: newStatus } };
  }

  async function cancelTrip(command) {
    const trip = await adminRepository.findTrip(command.id);
    if (!trip) return { ok: false, code: AdminError.TRIP_NOT_FOUND };
    await adminRepository.cancelTripByAdmin(command.id);
    if (trip.driver_id) await adminRepository.setDriverTaxiOnline(trip.driver_id);
    adminRepository.emitTripCancelled(trip, command.id);
    return { ok: true, value: {} };
  }

  async function addTaxi(command) {
    const gate = taxiCreationPolicy(command.name, command.lat, command.lng, validateCoords);
    if (!gate.allowed) return { ok: false, code: gate.code };
    const result = await adminRepository.addTaxi(gate.name, gate.lat, gate.lng);
    return { ok: true, value: { id: result.lastID } };
  }

  async function deleteTaxi(command) {
    await adminRepository.deleteTaxi(command.id);
    return { ok: true, value: {} };
  }

  async function resolveReport(command) {
    await adminRepository.resolveReport(command.id);
    return { ok: true, value: {} };
  }

  async function createBackup() {
    await configurationRepository.createBackup();
    return { ok: true, value: {} };
  }

  async function vacuum() {
    await configurationRepository.vacuum();
    return { ok: true, value: {} };
  }
  async function reindex() {
    await configurationRepository.reindex();
    return { ok: true, value: {} };
  }
  async function clearLogs() {
    return { ok: true, value: await loggingGateway.clearLogs() };
  }

  async function restore(command, basename) {
    const gate = restorePolicy(command.filename, command.confirm, basename);
    if (!gate.allowed) return { ok: false, code: gate.code };
    const result = await configurationRepository.restore(gate.safeFilename, command.filename);
    if (!result.exists) return { ok: false, code: AdminError.BACKUP_NOT_FOUND };
    return { ok: true, value: { safetyBackup: result.safetyBackup } };
  }

  async function shutdown(command) {
    const gate = shutdownPolicy(command.confirm);
    if (!gate.allowed) return { ok: false, code: gate.code };
    loggingGateway.scheduleShutdown();
    return { ok: true, value: {} };
  }

  return {
    stats,
    dashboard,
    revenue,
    listUsers,
    listReports,
    analytics,
    backups,
    systemInfo,
    dbHealth,
    metrics,
    securityEvents,
    errors,
    crashes,
    notificationStats,
    logs,
    getUser,
    listTrips,
    toggleUser,
    cancelTrip,
    addTaxi,
    deleteTaxi,
    resolveReport,
    createBackup,
    vacuum,
    reindex,
    clearLogs,
    restore,
    shutdown,
  };
}

module.exports = { createAdminUseCases, AdminError };
