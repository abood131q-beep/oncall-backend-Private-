'use strict';

/**
 * policies.js — Consolidated Identity Kernel domain (Phase 20.a, ADR-049 §5).
 *
 * The SINGLE future locus for identity authorization decisions (admin / role / permission),
 * resolving the triplication found in Phase 19.1 (V3). PURE domain, no I/O, deterministic.
 *
 * SHADOW PHASE: these implementations mirror the legacy authorization exactly (a byte-identical
 * reimplementation the Identity shadow compares against legacy). They are NON-authoritative —
 * `middleware/auth.js` / `loginPolicy.js` remain the sole production authority. The shadow proves
 * these produce identical decisions; nothing in production calls them yet.
 *
 * Legacy reference (mirrored):
 *   authenticateAdmin: `payload.role === 'admin' || ADMIN_PHONES.includes(payload.phone)`
 *   loginPolicy.isAdminPhone: `Array.isArray(adminPhones) && adminPhones.includes(phone)`
 */

/** Admin determination — mirrors legacy exactly: admin role claim OR configured admin phone. */
function isAdmin(principal, adminPhones) {
  if (!principal) return false;
  const claims = principal.claims || {};
  const roleIsAdmin =
    claims.role === 'admin' ||
    (Array.isArray(principal.roles) && principal.roles.includes('admin'));
  const phoneIsAdmin = Array.isArray(adminPhones) && adminPhones.includes(claims.phone);
  return Boolean(roleIsAdmin || phoneIsAdmin);
}

/** Permission check against a principal's permission set (pure). */
function can(principal, action) {
  return Boolean(
    principal && Array.isArray(principal.permissions) && principal.permissions.includes(action)
  );
}

/** Role membership check (pure). */
function hasRole(principal, role) {
  return Boolean(principal && Array.isArray(principal.roles) && principal.roles.includes(role));
}

module.exports = { isAdmin, can, hasRole };
