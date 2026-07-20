'use strict';

const { approvalStatus, reason } = require('./driverValues');

const DriversRejection = Object.freeze({
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  DRIVER_NOT_APPROVED: 'DRIVER_NOT_APPROVED',
  ALREADY_APPROVED: 'ALREADY_APPROVED',
  ALREADY_REJECTED: 'ALREADY_REJECTED',
  ALREADY_SUSPENDED: 'ALREADY_SUSPENDED',
  IS_PENDING: 'IS_PENDING',
  REASON_TOO_SHORT: 'REASON_TOO_SHORT',
  REASON_TOO_LONG: 'REASON_TOO_LONG',
});

function approvalDecision(current) {
  return approvalStatus(current) === 'approved'
    ? { allowed: false, code: DriversRejection.ALREADY_APPROVED }
    : { allowed: true, action: 'APPROVED', next: 'approved' };
}

function rejectionDecision(current, rawReason) {
  const checked = reason(rawReason);
  if (!checked.valid) return { allowed: false, code: DriversRejection[checked.code] };
  return approvalStatus(current) === 'rejected'
    ? { allowed: false, code: DriversRejection.ALREADY_REJECTED }
    : { allowed: true, action: 'REJECTED', next: 'rejected', reason: checked.value };
}

function suspensionDecision(current, rawReason) {
  const checked = reason(rawReason);
  if (!checked.valid) return { allowed: false, code: DriversRejection[checked.code] };
  return approvalStatus(current) === 'suspended'
    ? { allowed: false, code: DriversRejection.ALREADY_SUSPENDED }
    : { allowed: true, action: 'SUSPENDED', next: 'suspended', reason: checked.value };
}

function reactivationDecision(current) {
  const status = approvalStatus(current);
  if (status === 'approved') return { allowed: false, code: DriversRejection.ALREADY_APPROVED };
  if (status === 'pending') return { allowed: false, code: DriversRejection.IS_PENDING };
  return { allowed: true, action: 'REACTIVATED', next: 'approved' };
}

module.exports = {
  DriversRejection,
  approvalDecision,
  rejectionDecision,
  suspensionDecision,
  reactivationDecision,
};
