'use strict';

/**
 * Admin routes — Presentation layer (Enterprise Architecture Migration Phase 8).
 *
 * Strangler cutover for the Admin bounded context. Legacy src/routes/admin.js
 * remains as the instant-rollback implementation, selected via ADMIN_LEGACY=1
 * (see server.js). Paths, middleware (authenticateAdmin), status codes, JSON
 * shapes, key order, and Arabic messages are byte-identical to the legacy
 * router — proven by the live A/B harness (tests/integration/admin-ab.mjs).
 *
 * SCOPE (frozen): ONLY the general admin capabilities are migrated —
 * dashboard/stats/reports, user & trip & taxi administration, reports,
 * audit/maintenance/configuration, logs/metrics/system. The driver-approval
 * workflow was migrated with Drivers (Phase 4). Wallet/Payments/Fleet/AI are
 * NOT migrated; no new administrative capability is introduced.
 *
 * Composition root: framework/adapter wiring is intentionally confined here.
 * The heavy legacy SQL and system integrations (analytics, logger, metrics,
 * FS backups, PRAGMA maintenance, process lifecycle) are REUSED via the
 * infrastructure adapters, never reimplemented.
 */

const express = require('express');
const { NODE_ENV, PORT, TZ } = require('../../config/env');

const { createAdminApplication } = require('../../application/admin');
const {
  createAdminRepositoryAdapter,
} = require('../../infrastructure/repositories/adminRepositoryAdapter');
const {
  createAdminAuditRepository,
  createAdminConfigurationRepository,
  createAdminNotificationGateway,
  createAdminLoggingGateway,
} = require('../../infrastructure/gateways/adminOpsGateways');
const { createAdminController } = require('./adminController');

function createAdminRouter(services) {
  // Adapters read from the existing DI container; system env vars come from the
  // hardened env module (P6-05B), matching the legacy route exactly.
  const deps = { ...services, NODE_ENV, PORT, TZ };

  const app = createAdminApplication({
    adminRepository: createAdminRepositoryAdapter(deps),
    auditRepository: createAdminAuditRepository(deps),
    configurationRepository: createAdminConfigurationRepository(deps),
    notificationGateway: createAdminNotificationGateway(deps),
    loggingGateway: createAdminLoggingGateway(deps),
    auditLog: services.logger,
    validateCoords: services.validateCoords,
  });

  const c = createAdminController(app, services.logger);
  const router = express.Router();
  const { authenticateAdmin } = services;

  // ── Statistics & dashboards ────────────────────────────────────────────────
  router.get('/admin/stats', authenticateAdmin, c.stats);
  router.get('/admin/dashboard', authenticateAdmin, c.dashboard);
  router.get('/admin/revenue', authenticateAdmin, c.revenue);
  router.get('/admin/analytics', authenticateAdmin, c.analytics);

  // ── Trip administration ────────────────────────────────────────────────────
  router.get('/admin/trips', authenticateAdmin, c.listTrips);
  router.put('/admin/trips/:id/cancel', authenticateAdmin, c.cancelTrip);

  // ── User administration ────────────────────────────────────────────────────
  router.get('/admin/users', authenticateAdmin, c.listUsers);
  router.get('/admin/users/:phone', authenticateAdmin, c.getUser);
  router.put('/admin/users/:phone/toggle', authenticateAdmin, c.toggleUser);

  // ── Taxi (Fleet) administration — raw passthrough, Fleet not yet migrated ──
  router.post('/admin/taxis', authenticateAdmin, c.addTaxi);
  router.delete('/admin/taxis/:id', authenticateAdmin, c.deleteTaxi);

  // ── Reports ────────────────────────────────────────────────────────────────
  router.get('/admin/reports', authenticateAdmin, c.listReports);
  router.put('/admin/reports/:id/resolve', authenticateAdmin, c.resolveReport);

  // ── Backups / configuration ────────────────────────────────────────────────
  router.get('/admin/backups', authenticateAdmin, c.backups);
  router.post('/admin/backup', authenticateAdmin, c.createBackup);
  router.post('/admin/db/restore', authenticateAdmin, c.restore);

  // ── Logs ───────────────────────────────────────────────────────────────────
  router.get('/admin/logs', authenticateAdmin, c.logs);
  router.post('/admin/logs/clear', authenticateAdmin, c.clearLogs);

  // ── Database maintenance ───────────────────────────────────────────────────
  router.get('/admin/db/health', authenticateAdmin, c.dbHealth);
  router.post('/admin/db/vacuum', authenticateAdmin, c.vacuum);
  router.post('/admin/db/reindex', authenticateAdmin, c.reindex);

  // ── System / observability ─────────────────────────────────────────────────
  router.get('/admin/system', authenticateAdmin, c.systemInfo);
  router.get('/admin/metrics', authenticateAdmin, c.metrics);
  router.get('/admin/security-events', authenticateAdmin, c.securityEvents);
  router.get('/admin/errors', authenticateAdmin, c.errors);
  router.get('/admin/crashes', authenticateAdmin, c.crashes);
  router.get('/admin/notification-stats', authenticateAdmin, c.notificationStats);

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  router.post('/admin/shutdown', authenticateAdmin, c.shutdown);

  return router;
}

module.exports = { createAdminRouter };
