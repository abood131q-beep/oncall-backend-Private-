'use strict';

/**
 * Identity domain rules — pure business decisions extracted from the legacy
 * auth routes (strangler migration, Phase 1). These are the invariants; the
 * Application layer asks, this module decides (ADR-005 §1).
 *
 * Pure: no I/O, no framework, no persistence (ADR-005 §18 dependency rules).
 * Behavior is a 1:1 extraction of src/routes/auth.js decision logic — any
 * intentional change requires an ADR amendment, not an edit here.
 */

/** Outcome codes shared with the Application layer. */
const IdentityRejection = Object.freeze({
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  DRIVER_PENDING: 'DRIVER_PENDING',
  DRIVER_REJECTED: 'DRIVER_REJECTED',
  DRIVER_SUSPENDED: 'DRIVER_SUSPENDED',
});

/**
 * Passenger account gate: may this user receive a session?
 * Mirrors: `if (user.is_active === 0) → 403 suspended`.
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
function passengerLoginGate(user) {
  if (user && user.is_active === 0) {
    return { allowed: false, code: IdentityRejection.ACCOUNT_SUSPENDED };
  }
  return { allowed: true };
}

/**
 * Driver approval gate — approval_status is the single source of truth
 * (P6-06 rule). No token may ever be issued for a non-approved driver.
 * @returns {{ allowed: true }
 *   | { allowed: false, code: string, status: string, reason: string|null }}
 */
function driverLoginGate(driver) {
  const status = (driver && driver.approval_status) || 'pending';
  if (status === 'approved') return { allowed: true };
  if (status === 'rejected') {
    return {
      allowed: false,
      code: IdentityRejection.DRIVER_REJECTED,
      status,
      reason: (driver && driver.rejection_reason) || null,
    };
  }
  if (status === 'suspended') {
    return {
      allowed: false,
      code: IdentityRejection.DRIVER_SUSPENDED,
      status,
      reason: (driver && driver.suspended_reason) || null,
    };
  }
  return {
    allowed: false,
    code: IdentityRejection.DRIVER_PENDING,
    status: 'pending',
    reason: null,
  };
}

/**
 * Refresh gate for drivers (P6-06 security fix): a valid refresh token does
 * NOT entitle a non-approved driver to a new session; the token must be
 * revoked by the caller when this gate denies.
 * @returns {{ allowed: true } | { allowed: false, status: string }}
 */
function driverRefreshGate(driver) {
  if (driver && driver.approval_status === 'approved') return { allowed: true };
  return { allowed: false, status: (driver && driver.approval_status) || 'suspended' };
}

/** Admin determination — role claim OR configured admin phone list. */
function isAdminPhone(phone, adminPhones) {
  return Array.isArray(adminPhones) && adminPhones.includes(phone);
}

/** Session payload builders — the shape is a frozen contract (mobile fleet). */
function passengerSessionPayload(user, phone, admin) {
  return { phone, type: 'passenger', name: user.name, role: admin ? 'admin' : 'passenger' };
}

function driverSessionPayload(driver, phone) {
  return { phone, type: 'driver', name: driver.name, role: 'driver', driverId: driver.id };
}

module.exports = {
  IdentityRejection,
  passengerLoginGate,
  driverLoginGate,
  driverRefreshGate,
  isAdminPhone,
  passengerSessionPayload,
  driverSessionPayload,
};
