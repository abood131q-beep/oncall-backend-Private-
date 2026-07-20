'use strict';

/**
 * Drivers aggregate root. Pure business state only: no HTTP, SQL, or adapters.
 * Persistence fields intentionally retain their legacy names for strangler parity.
 */
class Driver {
  constructor(row = {}) {
    this.row = row;
  }

  get phone() {
    return this.row.phone;
  }
  get id() {
    return this.row.id;
  }
  get approvalStatus() {
    return this.row.approval_status || 'pending';
  }
  get availability() {
    return this.row.status || 'offline';
  }
  isApproved() {
    return this.approvalStatus === 'approved';
  }

  availabilityChange(isOnline) {
    if (isOnline && !this.isApproved()) {
      return { allowed: false, status: this.approvalStatus };
    }
    return { allowed: true, status: isOnline ? 'online' : 'offline' };
  }

  profileChange({ name, carName, plate }) {
    // Legacy passes values (including undefined) through to SQLite unchanged.
    return { name, carName, plate };
  }
}

function reconstituteDriver(row) {
  return new Driver(row);
}

module.exports = { Driver, reconstituteDriver };
