'use strict';

/**
 * Admin domain — Policies (ADR-002 §5, ADR-005 §1).
 * The invariants; the Application asks, this module decides. Pure: no I/O,
 * no framework, no SQL. 1:1 extraction of the legacy admin route decisions.
 */

const {
  AdminRole,
  AuditAction,
  RESTORE_CONFIRM,
  SHUTDOWN_CONFIRM,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} = require('./adminValues');

const AdminRejection = Object.freeze({
  FORBIDDEN: 'FORBIDDEN',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  TRIP_NOT_FOUND: 'TRIP_NOT_FOUND',
  TAXI_NAME_REQUIRED: 'TAXI_NAME_REQUIRED',
  BAD_COORDS: 'BAD_COORDS',
  RESTORE_NOT_CONFIRMED: 'RESTORE_NOT_CONFIRMED',
  BAD_BACKUP_NAME: 'BAD_BACKUP_NAME',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
  SHUTDOWN_NOT_CONFIRMED: 'SHUTDOWN_NOT_CONFIRMED',
});

/** RBAC / AdministrativeAccess — the actor must hold the admin role. */
function rbacPolicy(user, adminPhones) {
  const ok =
    user &&
    (user.role === AdminRole.ADMIN ||
      (Array.isArray(adminPhones) && adminPhones.includes(user.phone)));
  return { allowed: Boolean(ok) };
}

/** AdministrativeAccess — normalize pagination exactly like legacy. */
function normalizePagination(page, limit) {
  return {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_LIMIT)),
  };
}

/** Clamp an observability "n" query to [.., cap] with a default (legacy). */
function clampN(n, def, cap) {
  return Math.min(parseInt(n, 10) || def, cap);
}

/** MaintenancePolicy — DB restore requires the confirm token + a safe filename. */
function restorePolicy(filename, confirm, basename) {
  if (confirm !== RESTORE_CONFIRM) {
    return { allowed: false, code: AdminRejection.RESTORE_NOT_CONFIRMED };
  }
  const safe = basename(String(filename || ''));
  const valid = safe && /^[\w\-. ]+\.db$/.test(safe) && !safe.startsWith('.') && safe === filename;
  if (!valid) return { allowed: false, code: AdminRejection.BAD_BACKUP_NAME };
  return { allowed: true, safeFilename: safe };
}

/** MaintenancePolicy — shutdown requires the confirm token. */
function shutdownPolicy(confirm) {
  return confirm === SHUTDOWN_CONFIRM
    ? { allowed: true }
    : { allowed: false, code: AdminRejection.SHUTDOWN_NOT_CONFIRMED };
}

/** Taxi creation validity — name required, coords valid (with Kuwait defaults). */
function taxiCreationPolicy(name, lat, lng, validateCoords) {
  if (!name || !String(name).trim())
    return { allowed: false, code: AdminRejection.TAXI_NAME_REQUIRED };
  const parsedLat = lat != null ? parseFloat(lat) : 29.3765;
  const parsedLng = lng != null ? parseFloat(lng) : 47.9785;
  if (!validateCoords(parsedLat, parsedLng))
    return { allowed: false, code: AdminRejection.BAD_COORDS };
  return { allowed: true, name: String(name).trim(), lat: parsedLat, lng: parsedLng };
}

/** AuditPolicy — is this an action that must be recorded? */
function isAudited(action) {
  return Object.values(AuditAction).includes(action);
}

/** ApprovalPolicy — user activation toggle (driver approval lives in Drivers ctx). */
function toggleActive(currentIsActive) {
  return currentIsActive === 0 ? 1 : 0;
}

module.exports = {
  AdminRejection,
  rbacPolicy,
  normalizePagination,
  clampN,
  restorePolicy,
  shutdownPolicy,
  taxiCreationPolicy,
  isAudited,
  toggleActive,
};
