'use strict';

/**
 * Users slice tests — proves the migrated Application + Domain layers
 * reproduce the legacy src/routes/users.js behavior with pure fakes (no
 * transport, no storage, no framework — the layering promise, verified).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  displayName,
  tryCreateLocale,
  DEFAULT_LOCALE,
} = require('../../src/domain/users/profileValues');
const {
  balanceReadAuthorization,
  normalizeReportType,
  UsersRejection,
} = require('../../src/domain/users/userPolicies');
const { reconstituteUser } = require('../../src/domain/users/User');
const { createUsersApplication, UsersError } = require('../../src/application/users');

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeFakes() {
  const users = new Map([
    ['55500001', { id: 1, phone: '55500001', name: 'A', balance: 3.5, is_active: 1 }],
  ]);
  const reports = [];
  const readMarks = [];
  const ports = {
    userRepository: {
      updateName: async (phone, name) => {
        const u = users.get(phone) || { id: 9, phone };
        u.name = name;
        users.set(phone, u);
        return u;
      },
      submitReport: async (phone, type, description, tripId) => {
        reports.push({ phone, type, description, tripId });
      },
    },
    readModel: {
      getBalance: async (phone) => users.get(phone) && { balance: users.get(phone).balance },
      getActivity: async (phone) => [{ id: 1, phone, type: 'trip_payment', amount: 1 }],
    },
    notificationPreferences: {
      list: async (phone) => [{ id: 1, phone, title: 'x', is_read: 0 }],
      markAllRead: async (phone) => readMarks.push(phone),
    },
    auditLog: { info() {}, warn() {} },
  };
  return { ports, reports, readMarks, users };
}

// ── Domain: value objects ────────────────────────────────────────────────────

test('displayName: absent name is preserved as undefined (legacy pass-through)', () => {
  assert.deepEqual(displayName(undefined), { present: false, value: undefined });
  assert.deepEqual(displayName(null), { present: false, value: undefined });
  assert.deepEqual(displayName('Ali'), { present: true, value: 'Ali' });
});

test('Locale VO: supported tags normalize; unknown rejected; default is ar', () => {
  assert.deepEqual(tryCreateLocale('AR'), { valid: true, value: 'ar' });
  assert.deepEqual(tryCreateLocale('en-US'), { valid: true, value: 'en' });
  assert.equal(tryCreateLocale('fr').valid, false);
  assert.equal(DEFAULT_LOCALE, 'ar');
});

test('User aggregate: rename returns pass-through name; isActive reflects is_active', () => {
  const u = reconstituteUser({ phone: '5', name: 'x', is_active: 0 });
  assert.equal(u.isActive(), false);
  assert.deepEqual(u.rename('y'), { name: 'y' });
  assert.equal(u.locale, DEFAULT_LOCALE);
});

// ── Domain: policies ─────────────────────────────────────────────────────────

test('balanceReadAuthorization: self allowed, other forbidden', () => {
  assert.deepEqual(balanceReadAuthorization('5', '5'), { allowed: true });
  assert.deepEqual(balanceReadAuthorization('5', '6'), {
    allowed: false,
    code: UsersRejection.FORBIDDEN_OTHER_USER,
  });
});

test('normalizeReportType: defaults to general', () => {
  assert.equal(normalizeReportType(undefined), 'general');
  assert.equal(normalizeReportType('bug'), 'bug');
});

// ── Application: use cases ───────────────────────────────────────────────────

test('updateProfile: returns updated user row', async () => {
  const { ports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.updateProfileCommand({ actorPhone: '55500001', name: 'New' });
  const r = await app.useCases.updateProfile(p.command);
  assert.equal(r.ok, true);
  assert.equal(r.value.user.name, 'New');
});

test('getBalance: self ok', async () => {
  const { ports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.getBalanceCommand({ actorPhone: '55500001', targetPhone: '55500001' });
  const r = await app.useCases.getBalance(p.command);
  assert.deepEqual(r, { ok: true, value: { balance: 3.5 } });
});

test('getBalance: other phone → FORBIDDEN_OTHER_USER (IDOR guard)', async () => {
  const { ports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.getBalanceCommand({ actorPhone: '55500001', targetPhone: '55500002' });
  const r = await app.useCases.getBalance(p.command);
  assert.equal(r.ok, false);
  assert.equal(r.code, UsersError.FORBIDDEN_OTHER_USER);
});

test('getBalance: unknown subject → USER_NOT_FOUND', async () => {
  const { ports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.getBalanceCommand({ actorPhone: '99999999', targetPhone: '99999999' });
  const r = await app.useCases.getBalance(p.command);
  assert.equal(r.code, UsersError.USER_NOT_FOUND);
});

test('getActivity: ignores path phone, returns projection', async () => {
  const { ports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.getActivityCommand({ actorPhone: '55500001' });
  const r = await app.useCases.getActivity(p.command);
  assert.equal(r.ok, true);
  assert.equal(Array.isArray(r.value.activity), true);
});

test('markNotificationsRead: marks the authenticated phone', async () => {
  const { ports, readMarks } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.markNotificationsReadCommand({ actorPhone: '55500001' });
  await app.useCases.markNotificationsRead(p.command);
  assert.deepEqual(readMarks, ['55500001']);
});

test('submitReport: defaults type to general and trip_id to null', async () => {
  const { ports, reports } = makeFakes();
  const app = createUsersApplication(ports);
  const p = app.commands.submitReportCommand({ actorPhone: '55500001', description: 'hi' });
  await app.useCases.submitReport(p.command);
  assert.deepEqual(reports[0], {
    phone: '55500001',
    type: 'general',
    description: 'hi',
    tripId: null,
  });
});

test('ports: composition fails fast when a port method is missing', () => {
  assert.throws(() =>
    createUsersApplication({
      userRepository: {},
      readModel: {},
      notificationPreferences: {},
      auditLog: {},
    })
  );
});
