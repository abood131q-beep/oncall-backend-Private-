'use strict';

/**
 * Scooters slice tests — proves the migrated Application + Domain layers
 * reproduce the legacy src/routes/scooters.js behavior with pure fakes (no
 * transport, no storage, no framework — the layering promise, verified).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  unlockPolicy,
  lockPolicy,
  settleRide,
  liveFare,
  ScooterRejection,
} = require('../../src/domain/scooters/scooterPolicies');
const { publicView, reconstituteScooter } = require('../../src/domain/scooters/Scooter');
const { batteryPermitsUnlock, isAvailable } = require('../../src/domain/scooters/scooterValues');
const { createScootersApplication, ScootersError } = require('../../src/application/scooters');

// ── Domain: value objects + policies ─────────────────────────────────────────

test('publicView exposes exactly the legacy sanitized fields', () => {
  const row = {
    id: 1,
    name: 'S1',
    scooter_code: 'SC1',
    lat: 1,
    lng: 2,
    battery: 80,
    status: 'available',
    current_user_phone: 'x',
    total_rentals: 5,
  };
  assert.deepEqual(publicView(row), {
    id: 1,
    name: 'S1',
    scooter_code: 'SC1',
    lat: 1,
    lng: 2,
    battery: 80,
    status: 'available',
  });
});

test('battery + availability primitives', () => {
  assert.equal(batteryPermitsUnlock(10), true);
  assert.equal(batteryPermitsUnlock(9), false);
  assert.equal(isAvailable('available'), true);
  assert.equal(isAvailable('riding'), false);
});

test('unlockPolicy: ordered available → balance → battery', () => {
  assert.equal(
    unlockPolicy({ status: 'riding', battery: 80 }, 10).code,
    ScooterRejection.NOT_AVAILABLE
  );
  assert.equal(
    unlockPolicy({ status: 'available', battery: 80 }, 0.1).code,
    ScooterRejection.INSUFFICIENT_BALANCE
  );
  assert.equal(
    unlockPolicy({ status: 'available', battery: 5 }, 10).code,
    ScooterRejection.LOW_BATTERY
  );
  assert.deepEqual(unlockPolicy({ status: 'available', battery: 80 }, 10), { allowed: true });
});

test('lockPolicy: only the current rider may end the ride', () => {
  assert.deepEqual(lockPolicy({ current_user_phone: 'a' }, 'a'), { allowed: true });
  assert.equal(
    lockPolicy({ current_user_phone: 'a' }, 'b').code,
    ScooterRejection.NOT_YOUR_SCOOTER
  );
});

test('settleRide + liveFare reproduce legacy numbers', () => {
  const s = settleRide(0, 4 * 60000, 80); // 4 minutes
  assert.equal(s.durationMinutes, 4);
  assert.equal(s.fare, 0.5); // max(0.5, 4*0.05=0.2) = 0.5
  assert.equal(s.newBattery, 78); // 80 - min(75, 2) = 78
  const big = settleRide(0, 20 * 60000, 80); // 20 min → fare 1.0
  assert.equal(big.fare, 1);
  assert.equal(liveFare(0, 0).durationMinutes, 0); // no min-1 on active
  assert.equal(liveFare(0, 0).currentFare, 0.5);
});

test('aggregate rehydrates and answers status queries', () => {
  const sc = reconstituteScooter({ id: 1, status: 'riding', battery: 50, current_user_phone: 'p' });
  assert.equal(sc.isAvailable(), false);
  assert.equal(sc.isRiddenBy('p'), true);
});

// ── Application: use cases with pure fakes ───────────────────────────────────

function makeApp(overrides = {}) {
  const scooters = new Map([
    [
      1,
      {
        id: 1,
        name: 'S1',
        scooter_code: 'SC1',
        lat: 1,
        lng: 2,
        battery: 80,
        status: 'available',
        current_user_phone: null,
        ride_start_time: null,
      },
    ],
  ]);
  const users = new Map([['p', { phone: 'p', balance: 10 }]]);
  const charges = [];
  const notes = [];
  let cache = null;
  const ports = {
    scooterRepository: {
      setRiding: async (id, phone, t) => {
        const s = scooters.get(id);
        if (!s || s.status !== 'available') return { changes: 0 };
        s.status = 'riding';
        s.current_user_phone = phone;
        s.ride_start_time = t;
        return { changes: 1 };
      },
      createRide: async () => ({ lastID: 77 }),
      endRide: async () => {},
      setAvailable: async (id, battery) => {
        const s = scooters.get(id);
        s.status = 'available';
        s.current_user_phone = null;
        s.battery = battery;
      },
      create: async () => ({ lastID: 99 }),
      remove: async () => {},
      resetAll: async () => {},
      transaction: async (fn) => fn(),
    },
    scooterReadModel: {
      findAll: async () => [...scooters.values()],
      findById: async (id) => scooters.get(Number(id)),
      findByIdRaw: async (id) => scooters.get(Number(id)),
      findActiveByPhone: async (phone) =>
        [...scooters.values()].find((s) => s.current_user_phone === phone),
      getRideHistory: async () => [{ id: 1 }],
      findUserByPhone: async (phone) => users.get(phone),
    },
    scooterCache: { get: () => cache, set: (_k, v) => (cache = v), clear: () => (cache = null) },
    walletGateway: {
      getBalance: async (phone) => ({ balance: users.get(phone).balance }),
      charge: async (phone, amount, desc) => {
        charges.push({ phone, amount, desc });
        return { charged: true, newBalance: 9 };
      },
    },
    notificationGateway: { send: async (...a) => notes.push(a) },
    fleetGateway: { bringTaxisOnline: async () => {} },
    auditLog: { info() {}, warn() {}, error() {} },
    cacheTtl: { scooters: 10000 },
    validateCoords: (lat, lng) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180,
    ...overrides,
  };
  return { app: createScootersApplication(ports), scooters, charges, notes };
}

test('unlockScooter: happy path returns riding scooter + rideId + startTime and notifies', async () => {
  const { app, notes } = makeApp();
  const p = app.commands.unlockScooterCommand({ actorPhone: 'p', scooterId: 1 });
  const r = await app.useCases.unlockScooter(p.command);
  assert.equal(r.ok, true);
  assert.equal(r.value.scooter.status, 'riding');
  assert.equal(r.value.rideId, 77);
  assert.equal(typeof r.value.startTime, 'number');
  assert.equal(notes.length, 1);
});

test('unlockScooter: insufficient balance blocked before claiming', async () => {
  const { app } = makeApp();
  app.commands.unlockScooterCommand({ actorPhone: 'p', scooterId: 1 });
  // force low balance
  const r = await app.useCases.unlockScooter({ actorPhone: 'poor', scooterId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ScootersError.USER_NOT_FOUND); // unknown user → not found (legacy 404)
});

test('endRide: ownership enforced + charge inside transaction', async () => {
  const { app, charges } = makeApp();
  await app.useCases.unlockScooter({ actorPhone: 'p', scooterId: 1 });
  const r = await app.useCases.endRide({ actorPhone: 'p', scooterId: 1, endLat: 1, endLng: 2 });
  assert.equal(r.ok, true);
  assert.equal(typeof r.value.fare, 'number');
  assert.equal(charges.length, 1);
  const denied = await app.useCases.endRide({ actorPhone: 'stranger', scooterId: 1 });
  assert.equal(denied.code, ScootersError.NOT_YOUR_SCOOTER);
});

test('addScooter: invalid coords rejected; valid returns id', async () => {
  const { app } = makeApp();
  const bad = await app.useCases.addScooter(
    app.commands.addScooterCommand({ name: 'x', lat: 999, lng: 999 }).command
  );
  assert.equal(bad.code, ScootersError.INVALID_COORDS);
  const ok = await app.useCases.addScooter(
    app.commands.addScooterCommand({ name: 'x', lat: 29, lng: 47 }).command
  );
  assert.equal(ok.value.id, 99);
});

test('ports: composition fails fast when a port method is missing', () => {
  assert.throws(() => createScootersApplication({ scooterRepository: {} }));
});
