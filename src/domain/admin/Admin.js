'use strict';

/**
 * Admin — the Admin bounded-context Aggregate Root (ADR-002 §4).
 * Models an administrative actor and the permissions their role carries. Pure:
 * no I/O, no framework, no SQL (ADR-005 §18). The runtime access gate is the
 * `authenticateAdmin` middleware; this aggregate models the role/permission
 * vocabulary the Admin context reasons about.
 */

const { AdminRole, Permission } = require('./adminValues');

const ADMIN_PERMISSIONS = Object.freeze(Object.values(Permission));

function reconstituteAdmin(snapshot) {
  return new Admin(snapshot || {});
}

class Admin {
  constructor({ phone, role } = {}) {
    this._phone = phone;
    this._role = role;
  }

  get phone() {
    return this._phone;
  }

  isAdmin() {
    return this._role === AdminRole.ADMIN;
  }

  /** An admin holds every administrative permission (flat RBAC, as today). */
  can(permission) {
    return this.isAdmin() && ADMIN_PERMISSIONS.includes(permission);
  }
}

module.exports = { Admin, reconstituteAdmin, ADMIN_PERMISSIONS };
