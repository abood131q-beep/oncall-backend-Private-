'use strict';

/**
 * Identity slice tests — proves the migrated Application + Domain layers
 * reproduce the legacy auth behavior with pure fakes (no transport, no
 * storage, no framework — the layering promise, verified).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryCreatePhone } = require('../../src/domain/shared/Phone');
const {
  passengerLoginGate,
  driverLoginGate,
  driverRefreshGate,
} = require('../../src/domain/identity/loginPolicy');
const { createIdentityApplication, AuthRejection } = require('../../src/application/identity');

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeFakes({ otpRequired = false, otpValid = true } = {}) {
  const users = new Map();
  const drivers = new Map();
  const refreshStore = new Map(); // token → payload
  const revokedAccess = new Set();
  const loginLogs = [];
  let seq = 0;

  const ports = {
    identityRepository: {
      findUserByPhone: async (p) => users.get(p),
      createUser: async (p, name) => {
        const u = { id: ++seq, phone: p, name: name || 'راكب', is_active: 1 };
        users.set(p, u);
        return u;
      },
      findDriverByPhone: async (p) => drivers.get(p),
      createDriver: async (p) => {
        const d = { id: ++seq, phone: p, name: 'سائق', approval_status: 'pending' };
        drivers.set(p, d);
        return d;
      },
      setDriverPresence: async () => {},
      recordLoginLog: (phone, type) => loginLogs.push({ phone, type }),
    },
    tokenGateway: {
      issueAccessToken: (payload) => `AT:${payload.phone}:${payload.role}`,
      issueRefreshToken: async (payload) => {
        const t = `RT:${payload.phone}:${++seq}`;
        refreshStore.set(t, payload);
        return t;
      },
      verifyRefreshToken: async (t) => refreshStore.get(t) || null,
      revokeRefreshToken: async (t) => {
        refreshStore.delete(t);
      },
      revokeAllRefreshTokens: async (phone) => {
        for (const [t, p] of refreshStore) if (p.phone === phone) refreshStore.delete(t);
      },
      verifyAccessToken: (t) => {
        if (!t || !t.startsWith('AT:')) return null;
        const [, phone, role] = t.split(':');
        return { phone, role };
      },
      revokeAccessTokens: (phone) => revokedAccess.add(phone),
    },
    otpGateway: {
      isRequired: () => otpRequired,
      send: async () => {},
      verify: async () => otpValid,
    },
    auditLog: { info: () => {}, warn: () => {}, security: () => {} },
    adminPhones: ['11111111'],
  };

  return { ports, users, drivers, refreshStore, revokedAccess, loginLogs };
}

function app(opts) {
  const fakes = makeFakes(opts);
  const identity = createIdentityApplication(fakes.ports);
  return { ...fakes, identity };
}

// ── Domain rules (pure) ──────────────────────────────────────────────────────

test('Phone VO mirrors the legacy validation rule', () => {
  assert.equal(tryCreatePhone('99999999').valid, true);
  assert.equal(tryCreatePhone('+965 9999-9999').valid, true);
  assert.equal(tryCreatePhone('').valid, false);
  assert.equal(tryCreatePhone('ab').valid, false);
  assert.equal(tryCreatePhone('++--').valid, false); // no digit
  assert.equal(tryCreatePhone('1'.repeat(21)).valid, false);
});

test('passenger gate blocks suspended accounts only', () => {
  assert.equal(passengerLoginGate({ is_active: 1 }).allowed, true);
  assert.equal(passengerLoginGate({ is_active: 0 }).allowed, false);
});

test('driver gate: approval_status is the single source of truth', () => {
  assert.equal(driverLoginGate({ approval_status: 'approved' }).allowed, true);
  assert.equal(driverLoginGate({ approval_status: 'pending' }).status, 'pending');
  assert.equal(driverLoginGate({}).status, 'pending'); // default
  const rejected = driverLoginGate({ approval_status: 'rejected', rejection_reason: 'x' });
  assert.deepEqual([rejected.allowed, rejected.reason], [false, 'x']);
  const suspended = driverLoginGate({ approval_status: 'suspended' });
  assert.deepEqual([suspended.allowed, suspended.reason], [false, null]);
});

test('driver refresh gate denies everything but approved', () => {
  assert.equal(driverRefreshGate({ approval_status: 'approved' }).allowed, true);
  assert.equal(driverRefreshGate({ approval_status: 'suspended' }).status, 'suspended');
  assert.equal(driverRefreshGate(undefined).status, 'suspended'); // missing driver
});

// ── Use cases ────────────────────────────────────────────────────────────────

test('passenger login: implicit registration + tokens + login log', async () => {
  const { identity, users, loginLogs } = app();
  const cmd = identity.commands.loginPassengerCommand({ phone: '99999999', ip: '::1' }, false);
  const r = await identity.useCases.loginPassenger(cmd.command);
  assert.equal(r.ok, true);
  assert.equal(users.has('99999999'), true);
  assert.match(r.value.token, /^AT:/);
  assert.match(r.value.refreshToken, /^RT:/);
  assert.deepEqual(loginLogs[0], { phone: '99999999', type: 'passenger' });
});

test('admin passenger receives NO refresh token (frozen contract)', async () => {
  const { identity } = app();
  const cmd = identity.commands.loginPassengerCommand({ phone: '11111111' }, false);
  const r = await identity.useCases.loginPassenger(cmd.command);
  assert.equal(r.ok, true);
  assert.equal(r.value.refreshToken, null);
  assert.match(r.value.token, /admin$/);
});

test('suspended passenger is rejected', async () => {
  const { identity, users } = app();
  users.set('90000000', { phone: '90000000', name: 'x', is_active: 0 });
  const cmd = identity.commands.loginPassengerCommand({ phone: '90000000' }, false);
  const r = await identity.useCases.loginPassenger(cmd.command);
  assert.deepEqual([r.ok, r.code], [false, AuthRejection.ACCOUNT_SUSPENDED]);
});

test('OTP required: missing otp rejected at command, wrong otp at use case', async () => {
  const { identity } = app({ otpRequired: true, otpValid: false });
  const noOtp = identity.commands.loginPassengerCommand({ phone: '99999999' }, true);
  assert.equal(noOtp.ok, false);
  const cmd = identity.commands.loginPassengerCommand({ phone: '99999999', otp: '000000' }, true);
  const r = await identity.useCases.loginPassenger(cmd.command);
  assert.deepEqual([r.ok, r.code], [false, AuthRejection.OTP_INVALID]);
});

test('new driver is created pending and blocked from login', async () => {
  const { identity, drivers } = app();
  const cmd = identity.commands.loginDriverCommand({ phone: '98888888' }, false);
  const r = await identity.useCases.loginDriver(cmd.command);
  assert.deepEqual([r.ok, r.status], [false, 'pending']);
  assert.equal(drivers.get('98888888').approval_status, 'pending');
});

test('approved driver logs in; suspended driver is blocked with reason', async () => {
  const { identity, drivers } = app();
  drivers.set('97777777', { id: 7, phone: '97777777', name: 'د', approval_status: 'approved' });
  const ok = await identity.useCases.loginDriver(
    identity.commands.loginDriverCommand({ phone: '97777777' }, false).command
  );
  assert.equal(ok.ok, true);
  drivers.set('96666666', {
    id: 8,
    phone: '96666666',
    approval_status: 'suspended',
    suspended_reason: 'سبب',
  });
  const blocked = await identity.useCases.loginDriver(
    identity.commands.loginDriverCommand({ phone: '96666666' }, false).command
  );
  assert.deepEqual([blocked.status, blocked.reason], ['suspended', 'سبب']);
});

test('refresh rotates: old token dies, new token works', async () => {
  const { identity, refreshStore } = app();
  const login = await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '95555555' }, false).command
  );
  const oldRt = login.value.refreshToken;
  const r = await identity.useCases.refreshSession(
    identity.commands.refreshSessionCommand({ refreshToken: oldRt }).command
  );
  assert.equal(r.ok, true);
  assert.equal(refreshStore.has(oldRt), false); // rotated out
  assert.equal(refreshStore.has(r.value.refreshToken), true);
  const replay = await identity.useCases.refreshSession(
    identity.commands.refreshSessionCommand({ refreshToken: oldRt }).command
  );
  assert.deepEqual([replay.ok, replay.code], [false, AuthRejection.REFRESH_INVALID]);
});

test('P6-06 security: suspended driver refresh is blocked AND token revoked', async () => {
  const { identity, drivers, refreshStore } = app();
  drivers.set('94444444', { id: 9, phone: '94444444', name: 'د', approval_status: 'approved' });
  const login = await identity.useCases.loginDriver(
    identity.commands.loginDriverCommand({ phone: '94444444' }, false).command
  );
  drivers.get('94444444').approval_status = 'suspended';
  const rt = login.value.refreshToken;
  const r = await identity.useCases.refreshSession(
    identity.commands.refreshSessionCommand({ refreshToken: rt }).command
  );
  assert.deepEqual(
    [r.ok, r.code, r.status],
    [false, AuthRejection.DRIVER_REFRESH_BLOCKED, 'suspended']
  );
  assert.equal(refreshStore.has(rt), false); // revoked immediately
});

test('logout never fails and revokes what it can', async () => {
  const { identity, revokedAccess, refreshStore } = app();
  const login = await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '93333333' }, false).command
  );
  const r = await identity.useCases.logout(
    identity.commands.logoutCommand({
      accessToken: login.value.token,
      refreshToken: login.value.refreshToken,
    }).command
  );
  assert.equal(r.ok, true);
  assert.equal(revokedAccess.has('93333333'), true);
  assert.equal(refreshStore.has(login.value.refreshToken), false);
  // garbage input still succeeds (frozen contract)
  const junk = await identity.useCases.logout(
    identity.commands.logoutCommand({ accessToken: 'garbage' }).command
  );
  assert.equal(junk.ok, true);
});

test('logout-all requires an authenticated actor and revokes everything', async () => {
  const { identity, refreshStore, revokedAccess } = app();
  await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '92222222' }, false).command
  );
  await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '92222222' }, false).command
  );
  const denied = await identity.useCases.logoutAll(null);
  assert.deepEqual([denied.ok, denied.code], [false, AuthRejection.NOT_AUTHENTICATED]);
  const r = await identity.useCases.logoutAll({ phone: '92222222' });
  assert.equal(r.ok, true);
  assert.equal(revokedAccess.has('92222222'), true);
  for (const p of refreshStore.values()) assert.notEqual(p.phone, '92222222');
});

test('verifySession returns full payload for valid tokens, 401-class for invalid', async () => {
  const { identity } = app();
  const login = await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '91111111' }, false).command
  );
  const ok = identity.useCases.verifySession(login.value.token);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.session.phone, '91111111');
  assert.equal(identity.useCases.verifySession('junk').ok, false);
  assert.equal(identity.useCases.verifySession(undefined).ok, false);
});

test('checkAdmin: role claim OR admin phone list; data-minimized result', async () => {
  const { identity } = app();
  const adminLogin = await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '11111111' }, false).command
  );
  const admin = identity.useCases.checkAdmin(adminLogin.value.token);
  assert.deepEqual(admin, { ok: true, value: { isAdmin: true } });
  const userLogin = await identity.useCases.loginPassenger(
    identity.commands.loginPassengerCommand({ phone: '92345678' }, false).command
  );
  const user = identity.useCases.checkAdmin(userLogin.value.token);
  assert.deepEqual(user, { ok: true, value: { isAdmin: false } });
  assert.equal(identity.useCases.checkAdmin(null).ok, false);
});

test('composition fails fast on incomplete ports', () => {
  const { ports } = makeFakes();
  delete ports.tokenGateway.revokeRefreshToken;
  assert.throws(() => createIdentityApplication(ports), /revokeRefreshToken/);
});
