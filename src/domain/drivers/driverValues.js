'use strict';

/** Driver Status and Availability value objects (ADR-002/005, pure). */
const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'suspended']);
const AVAILABILITY_STATUSES = Object.freeze(['online', 'offline', 'busy']);

function approvalStatus(value) {
  return APPROVAL_STATUSES.includes(value) ? value : 'pending';
}

function availabilityStatus(value) {
  return AVAILABILITY_STATUSES.includes(value) ? value : 'offline';
}

function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 5)
    return { valid: false, code: 'REASON_TOO_SHORT' };
  if (value.trim().length > 500) return { valid: false, code: 'REASON_TOO_LONG' };
  return { valid: true, value: value.trim() };
}

module.exports = {
  APPROVAL_STATUSES,
  AVAILABILITY_STATUSES,
  approvalStatus,
  availabilityStatus,
  reason,
};
