'use strict';

/**
 * Admin slice tests — proves the migrated Domain + Application layers reproduce
 * the legacy src/routes/admin.js decisions with pure fakes (no transport, no
 * storage, no framework — the layering promise, verified). Covers RBAC,
 * pagination/clamp normalization, taxi-creation validity, DB-restore & shutdown
 * maintenance guards, audit classification, and the use-case orchestration for
 * getUser / listTrips / toggleUser / cancelTrip / addTaxi / restore / shutdown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rbacPolicy,
  normalizePagination,
  clampN,
  restorePolicy,
  shutdownPolicy,
  taxiCreationPolicy,
  isAudited,
  toggleActive,
  AdminRejection,
} = require('../../src/domain/admin/adminPolicies');
const { AuditAction } = require('../../src/domain/admin/adminValues');
const { createAdminApplication, AdminError } = require('../../src/application/admin');

const basename = require('path').basename;

// ── Domain: RBAC / AdministrativeAccess ──────────────────────────────────────

test('rbacPolicy admits the admin role and the allowlisted phone; denies others', () => {
  assert.equal(rbacPolicy({ role: 'admin' }, []).allowed, true);
  assert.equal(rbacPolicy({ phone: '111' }, ['111', '222']).allowed, true);
  assert.equal(rbacPolicy({ role: 'passenger', phone: '999' }, ['111']).allowed, false);
  assert.equal(rbacPolicy(null, ['111']).allowed, false);
});

// ── Domain: pagination + clamp normalization (legacy math, 1:1) ───────────────

test('normalizePagination clamps page>=1 and limit within [1,100] with defaults', () => {
  assert.deepEqual(normalizePagination(undefined, undefined), { page: 1, limit: 50 });
  assert.deepEqual(normalizePagination('-3', '9999'), { page: 1, limit: 100 });
  assert.deepEqual(normalizePagination('2', '10'), { page: 2, limit: 10 });
  // parseInt('0') is 0 → falsy → default 50 (faithful to legacy `|| 50`).
  assert.deepEqual(normalizePagination('abc', '0'), { page: 1, limit: 50 });
  assert.deepEqual(normalizePagination('1', '1'), { page: 1, limit: 1 });
});

test('clampN mirrors legacy Math.min(parseInt(n)||def, cap)', () => {
  assert.equal(clampN(undefined, 50, 200), 50);
  assert.equal(clampN('500', 50, 200), 200);
  assert.equal(clampN('30', 50, 200), 30);
  assert.equal(clampN('abc', 100, 200), 100);
});

// ── Domain: taxi-creation validity (Kuwait defaults) ─────────────────────────

test('taxiCreationPolicy requires a name, validates coords, applies Kuwait defaults', () => {
  const ok = () => true;
  assert.equal(taxiCreationPolicy('', 1, 2, ok).code, AdminRejection.TAXI_NAME_REQUIRED);
  assert.equal(taxiCreationPolicy('  ', 1, 2, ok).code, AdminRejection.TAXI_NAME_REQUIRED);
  const def = taxiCreationPolicy(' Downtown ', undefined, undefined, ok);
  assert.deepEqual(def, { allowed: true, name: 'Downtown', lat: 29.3765, lng: 47.9785 });
  assert.equal(taxiCreationPolicy('T', 999, 999, () => false).code, AdminRejection.BAD_COORDS);
});

// ── Domain: maintenance guards (restore + shutdown) ──────────────────────────

test('restorePolicy demands the confirm token then a traversal-safe *.db name', () => {
  assert.equal(restorePolicy('x.db', 'nope', basename).code, AdminRejection.RESTORE_NOT_CONFIRMED);
  assert.equal(
    restorePolicy('../../etc/passwd', 'RESTORE_CONFIRMED', basename).code,
    AdminRejection.BAD_BACKUP_NAME
  );
  assert.equal(
    restorePolicy('a/b.db', 'RESTORE_CONFIRMED', basename).code,
    AdminRejection.BAD_BACKUP_NAME
  );
  assert.equal(
    restorePolicy('.hidden.db', 'RESTORE_CONFIRMED', basename).code,
    AdminRejection.BAD_BACKUP_NAME
  );
  assert.deepEqual(restorePolicy('good.db', 'RESTORE_CONFIRMED', basename), {
    allowed: true,
    safeFilename: 'good.db',
  });
});

test('shutdownPolicy demands the explicit confirm token', () => {
  assert.equal(shutdownPolicy('SHUTDOWN_CONFIRMED').allowed, true);
  assert.equal(shutdownPolicy('').code, AdminRejection.SHUTDOWN_NOT_CONFIRMED);
});

test('isAudited recognizes audited actions; toggleActive flips 0<->1', () => {
  assert.equal(isAudited(Object.values(AuditAction)[0]), true);
  assert.equal(isAudited('NOT_A_REAL_ACTION'), false);
  assert.equal(toggleActive(0), 1);
  assert.equal(toggleActive(1), 0);
});

// ── Application: orchestration over pure fakes ───────────────────────────────

function makeApp(overrides = {}) {
  const base = {
    adminRepository: {
      getStats: async () => ({}),
      getDashboard: async () => ({}),
      getRevenue: async () => ({}),
      listUsers: async () => [{ phone: '1' }],
      getUser: async (p) => (p === 'known' ? { phone: 'known', is_active: 1 } : null),
      toggleUserActive: async () => {},
      listReports: async () => [],
      resolveReport: async () => {},
      addTaxi: async () => ({ lastID: 77 }),
      deleteTaxi: async () => {},
      listTripsPaginated: async () => [{ id: 1 }],
      countTrips: async () => 1,
      findTrip: async (id) => (id === 'known' ? { id: 'known', driver_id: 'd1' } : null),
      cancelTripByAdmin: async () => {},
      setDriverTaxiOnline: async () => {},
      emitTripCancelled: () => {},
    },
    auditRepository: {
      getAnalytics: async () => ({}),
      getSecurityEvents: async () => ({}),
      getErrors: async () => ({}),
      getCrashes: async () => ({}),
    },
    configurationRepository: {
      getSystemInfo: async () => ({}),
      getDbHealth: async () => ({}),
      vacuum: async () => {},
      reindex: async () => {},
      listBackups: async () => ({ backups: [] }),
      createBackup: async () => {},
      restore: async (name) =>
        name === 'good.db' ? { exists: true, safetyBackup: 's.db' } : { exists: false },
    },
    notificationGateway: { getStats: async () => ({}) },
    loggingGateway: {
      getLogs: async () => ({}),
      clearLogs: async () => ({ cleared: 0 }),
      getMetrics: async () => ({}),
      scheduleShutdown: () => {},
    },
    auditLog: { info: () => {}, warn: () => {}, error: () => {} },
    validateCoords: () => true,
  };
  return createAdminApplication({ ...base, ...overrides });
}

test('assertPorts fails fast when a port method is missing', () => {
  assert.throws(() => makeApp({ notificationGateway: {} }), /notificationGateway/);
});

test('getUser returns USER_NOT_FOUND for an unknown phone, the row otherwise', async () => {
  const { useCases, commands } = makeApp();
  const miss = await useCases.getUser(commands.phoneCommand({ phone: 'ghost' }).command);
  assert.deepEqual(miss, { ok: false, code: AdminError.USER_NOT_FOUND });
  const hit = await useCases.getUser(commands.phoneCommand({ phone: 'known' }).command);
  assert.equal(hit.ok, true);
  assert.equal(hit.value.user.phone, 'known');
});

test('listTrips builds the legacy pagination envelope', async () => {
  const { useCases, commands } = makeApp();
  const r = await useCases.listTrips(
    commands.paginationCommand({ page: '2', limit: '10', status: 'completed' }).command
  );
  assert.deepEqual(r.value.pagination, { page: 2, limit: 10, total: 1, pages: 1 });
  assert.deepEqual(r.value.trips, [{ id: 1 }]);
});

test('toggleUser flips is_active and 404s on an unknown phone', async () => {
  let saved = null;
  const app = makeApp({
    adminRepository: {
      getStats: async () => ({}),
      getDashboard: async () => ({}),
      getRevenue: async () => ({}),
      listUsers: async () => [],
      getUser: async (p) => (p === 'known' ? { phone: 'known', is_active: 1 } : null),
      toggleUserActive: async (_p, s) => {
        saved = s;
      },
      listReports: async () => [],
      resolveReport: async () => {},
      addTaxi: async () => ({ lastID: 1 }),
      deleteTaxi: async () => {},
      listTripsPaginated: async () => [],
      countTrips: async () => 0,
      findTrip: async () => null,
      cancelTripByAdmin: async () => {},
      setDriverTaxiOnline: async () => {},
      emitTripCancelled: () => {},
    },
  });
  const ok = await app.useCases.toggleUser(app.commands.phoneCommand({ phone: 'known' }).command);
  assert.deepEqual(ok, { ok: true, value: { is_active: 0 } });
  assert.equal(saved, 0);
  const miss = await app.useCases.toggleUser(app.commands.phoneCommand({ phone: 'x' }).command);
  assert.equal(miss.code, AdminError.USER_NOT_FOUND);
});

test('cancelTrip 404s when the trip is missing, else emits + returns ok', async () => {
  const { useCases, commands } = makeApp();
  const miss = await useCases.cancelTrip(commands.idCommand({ id: 'ghost' }).command);
  assert.equal(miss.code, AdminError.TRIP_NOT_FOUND);
  const ok = await useCases.cancelTrip(commands.idCommand({ id: 'known' }).command);
  assert.deepEqual(ok, { ok: true, value: {} });
});

test('addTaxi rejects a nameless request and returns lastID on success', async () => {
  const { useCases, commands } = makeApp();
  const bad = await useCases.addTaxi(commands.addTaxiCommand({ name: '' }).command);
  assert.equal(bad.code, AdminError.TAXI_NAME_REQUIRED);
  const ok = await useCases.addTaxi(commands.addTaxiCommand({ name: 'T' }).command);
  assert.deepEqual(ok, { ok: true, value: { id: 77 } });
});

test('restore enforces the guard, maps a missing backup to BACKUP_NOT_FOUND', async () => {
  const { useCases, commands } = makeApp();
  const noconfirm = await useCases.restore(
    commands.restoreCommand({ filename: 'good.db', confirm: 'no' }).command,
    basename
  );
  assert.equal(noconfirm.code, AdminError.RESTORE_NOT_CONFIRMED);
  const missing = await useCases.restore(
    commands.restoreCommand({ filename: 'nope.db', confirm: 'RESTORE_CONFIRMED' }).command,
    basename
  );
  assert.equal(missing.code, AdminError.BACKUP_NOT_FOUND);
  const ok = await useCases.restore(
    commands.restoreCommand({ filename: 'good.db', confirm: 'RESTORE_CONFIRMED' }).command,
    basename
  );
  assert.deepEqual(ok, { ok: true, value: { safetyBackup: 's.db' } });
});

test('shutdown requires the confirm token and schedules the shutdown', async () => {
  let scheduled = false;
  const app = makeApp({
    loggingGateway: {
      getLogs: async () => ({}),
      clearLogs: async () => ({}),
      getMetrics: async () => ({}),
      scheduleShutdown: () => {
        scheduled = true;
      },
    },
  });
  const bad = await app.useCases.shutdown(app.commands.shutdownCommand({ confirm: 'x' }).command);
  assert.equal(bad.code, AdminError.SHUTDOWN_NOT_CONFIRMED);
  assert.equal(scheduled, false);
  const ok = await app.useCases.shutdown(
    app.commands.shutdownCommand({ confirm: 'SHUTDOWN_CONFIRMED' }).command
  );
  assert.deepEqual(ok, { ok: true, value: {} });
  assert.equal(scheduled, true);
});
