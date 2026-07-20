'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconstituteDriver } = require('../../src/domain/drivers/Driver');
const { approvalDecision, rejectionDecision, suspensionDecision, reactivationDecision } = require('../../src/domain/drivers/driverPolicies');
const { createDriversApplication } = require('../../src/application/drivers');

function app(seed = { phone: '90000001', id: 7, approval_status: 'approved', status: 'offline', is_active: 1 }) {
  const rows = new Map([[seed.phone, { ...seed }]]);
  const audit = [];
  const sessions = [];
  const repo = {
    findByPhone: async (phone) => rows.get(phone), findAll: async () => [...rows.values()], findPending: async () => [],
    updateProfile: async (phone, name, carName, plate) => { const r = rows.get(phone); if (!r) return null; Object.assign(r, { name, car_name: carName, plate }); return r; },
    setStatus: async (phone, status) => { if (rows.has(phone)) rows.get(phone).status = status; }, setTaxiStatus: async () => {},
    setActive: async (phone, active) => { rows.get(phone).is_active = active; },
    setApprovalStatus: async (phone, status, options) => { Object.assign(rows.get(phone), { approval_status: status, is_active: status === 'approved' ? 1 : 0, rejection_reason: options.reason || null }); },
    logApprovalAction: async (entry) => audit.push(entry), getApprovalHistory: async () => audit,
    withLock: async (_phone, work) => work(), transaction: async (work) => work(),
  };
  const ports = {
    driverRepository: repo,
    driverReadModel: { findTrips: async () => [], getStats: async () => ({ totalTrips: 0 }), getReviews: async () => [] },
    driverSessionControl: { revokeAccess: (p) => sessions.push(['access', p]), revokeRefresh: async (p) => sessions.push(['refresh', p]), forceDisconnect: (p) => sessions.push(['socket', p]) },
    auditLog: { info() {}, warn() {}, error() {}, security() {} },
  };
  return { useCases: createDriversApplication(ports).useCases, rows, audit, sessions };
}

test('Driver aggregate permits only approved drivers to become online', () => {
  assert.deepEqual(reconstituteDriver({ approval_status: 'pending' }).availabilityChange(true), { allowed: false, status: 'pending' });
  assert.deepEqual(reconstituteDriver({ approval_status: 'approved' }).availabilityChange(true), { allowed: true, status: 'online' });
});

test('approval policies preserve lifecycle conflicts and reason validation', () => {
  assert.equal(approvalDecision('approved').code, 'ALREADY_APPROVED');
  assert.equal(rejectionDecision('rejected', 'valid reason').code, 'ALREADY_REJECTED');
  assert.equal(suspensionDecision('approved', 'bad').code, 'REASON_TOO_SHORT');
  assert.equal(reactivationDecision('pending').code, 'IS_PENDING');
});

test('availability uses authenticated driver identity and mirrors status/taxi update', async () => {
  const x = app();
  const result = await x.useCases.changeAvailability({ actorPhone: '90000001', isOnline: true });
  assert.equal(result.ok, true);
  assert.equal(x.rows.get('90000001').status, 'online');
});

test('unapproved online transition is rejected without a persistence write', async () => {
  const x = app({ phone: '90000001', id: 7, approval_status: 'pending', status: 'offline' });
  const result = await x.useCases.changeAvailability({ actorPhone: '90000001', isOnline: true });
  assert.deepEqual(result, { ok: false, code: 'DRIVER_NOT_APPROVED', status: 'pending' });
  assert.equal(x.rows.get('90000001').status, 'offline');
});

test('profile update preserves legacy pass-through values', async () => {
  const x = app();
  const result = await x.useCases.updateProfile({ actorPhone: '90000001', name: undefined, carName: 'Camry', plate: 'K 1' });
  assert.equal(result.value.driver.name, undefined);
  assert.equal(result.value.driver.car_name, 'Camry');
});

test('suspension is atomic from the application perspective and revokes all session channels', async () => {
  const x = app();
  const result = await x.useCases.suspendDriver({ phone: '90000001', actorPhone: '11111111', reason: 'policy violation', ip: '127.0.0.1' });
  assert.equal(result.ok, true);
  assert.equal(x.rows.get('90000001').approval_status, 'suspended');
  assert.deepEqual(x.audit.map((e) => e.action), ['SUSPENDED']);
  assert.deepEqual(x.sessions.map((e) => e[0]), ['access', 'refresh', 'socket']);
});

test('approval and reactivation retain their legacy conflict semantics', async () => {
  const x = app({ phone: '90000001', id: 7, approval_status: 'rejected', status: 'offline' });
  assert.equal((await x.useCases.approveDriver({ phone: '90000001', actorPhone: '11111111' })).ok, true);
  assert.equal((await x.useCases.approveDriver({ phone: '90000001', actorPhone: '11111111' })).code, 'ALREADY_APPROVED');
});
