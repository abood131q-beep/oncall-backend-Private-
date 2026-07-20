'use strict';

/**
 * Admin domain — Value Objects (ADR-002 §7, ADR-005 §18).
 * Pure: no I/O, no framework, no SQL. Constants extracted 1:1 from the legacy
 * src/routes/admin.js.
 */

// ── AdminRole VO ──────────────────────────────────────────────────────────────
const AdminRole = Object.freeze({ ADMIN: 'admin' });

// ── Permission VO ─────────────────────────────────────────────────────────────
// The administrative capabilities exposed by the legacy surface (documentation
// of the RBAC scope; the runtime gate is the `authenticateAdmin` middleware).
const Permission = Object.freeze({
  VIEW_DASHBOARD: 'view_dashboard',
  MANAGE_USERS: 'manage_users',
  MANAGE_TAXIS: 'manage_taxis',
  MANAGE_TRIPS: 'manage_trips',
  MANAGE_REPORTS: 'manage_reports',
  VIEW_ANALYTICS: 'view_analytics',
  RUN_MAINTENANCE: 'run_maintenance',
  VIEW_OBSERVABILITY: 'view_observability',
});

// ── AuditAction VO ────────────────────────────────────────────────────────────
const AuditAction = Object.freeze({
  USER_TOGGLE: 'USER_TOGGLE',
  TAXI_ADD: 'TAXI_ADD',
  TAXI_DELETE: 'TAXI_DELETE',
  TRIP_CANCEL: 'TRIP_CANCEL',
  REPORT_RESOLVE: 'REPORT_RESOLVE',
  DB_RESTORE: 'DB_RESTORE',
  DB_VACUUM: 'DB_VACUUM',
  DB_REINDEX: 'DB_REINDEX',
  LOGS_CLEAR: 'LOGS_CLEAR',
  SHUTDOWN: 'SHUTDOWN',
  BACKUP: 'BACKUP',
});

// ── Confirmation tokens + limits (legacy constants) ──────────────────────────
const RESTORE_CONFIRM = 'RESTORE_CONFIRMED';
const SHUTDOWN_CONFIRM = 'SHUTDOWN_CONFIRMED';
const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;

module.exports = {
  AdminRole,
  Permission,
  AuditAction,
  RESTORE_CONFIRM,
  SHUTDOWN_CONFIRM,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
};
