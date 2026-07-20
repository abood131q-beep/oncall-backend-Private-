'use strict';

/**
 * Fleet slice tests — proves the migrated Domain + Application layers reproduce
 * the legacy co-located Fleet behavior (`GET /taxis` + admin `POST/DELETE
 * /admin/taxis`) with pure fakes (no transport, no storage, no framework — the
 * layering promise, verified). Covers the value objects, the four Fleet
 * policies, and the three use cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VehicleStatus,
  availabilityOf,
  FleetAvailability,
  isVehicleStatus,
  VehicleId,
  DEFAULT_LAT,
  DEFAULT_LNG,
  REGISTERED_STATUS,
} = require('../../src/domain/fleet/fleetValues');
const {
  fleetRegistrationPolicy,
  fleetValidationPolicy,
  fleetAvailabilityPolicy,
  fleetAssignmentPolicy,
  FleetRejection,
} = require('../../src/domain/fleet/fleetPolicies');
const { reconstituteVehicle, newVehicle } = require('../../src/domain/fleet/Fleet');
const { createFleetApplication, FleetError } = require('../../src/application/fleet');

// ── Domain: value objects ────────────────────────────────────────────────────

test('VehicleStatus enum + availability derivation match legacy status semantics', () => {
  assert.equal(REGISTERED_STATUS, 'online');
  assert.equal(isVehicleStatus('online'), true);
  assert.equal(isVehicleStatus('flying'), false);
  assert.equal(availabilityOf(VehicleStatus.ONLINE), FleetAvailability.AVAILABLE);
  assert.equal(availabilityOf(VehicleStatus.BUSY), FleetAvailability.BUSY);
  assert.equal(availabilityOf(VehicleStatus.OFFLINE), FleetAvailability.OFFLINE);
  assert.equal(availabilityOf('anything-else'), FleetAvailability.OFFLINE);
  assert.equal(VehicleId(7), '7');
  assert.equal(VehicleId(null), null);
});

// ── Domain: policies ─────────────────────────────────────────────────────────

test('fleetRegistrationPolicy requires a name, validates coords, applies Kuwait defaults', () => {
  const ok = () => true;
  assert.equal(fleetRegistrationPolicy('', 1, 2, ok).code, FleetRejection.VEHICLE_NAME_REQUIRED);
  assert.equal(fleetRegistrationPolicy('  ', 1, 2, ok).code, FleetRejection.VEHICLE_NAME_REQUIRED);
  const def = fleetRegistrationPolicy(' Downtown ', undefined, undefined, ok);
  assert.deepEqual(def, { allowed: true, name: 'Downtown', lat: DEFAULT_LAT, lng: DEFAULT_LNG });
  assert.equal(fleetRegistrationPolicy('T', 999, 999, () => false).code, FleetRejection.BAD_COORDS);
});

test('fleetValidationPolicy exposes exactly the legacy sanitized fields', () => {
  const row = { id: 3, name: 'S1', lat: 1, lng: 2, status: 'online', driver_id: 9, secret: 'x' };
  assert.deepEqual(fleetValidationPolicy(row), {
    id: 3,
    name: 'S1',
    lat: 1,
    lng: 2,
    status: 'online',
  });
});

test('availability + assignment policies derive from status (online ⇒ assignable)', () => {
  assert.deepEqual(fleetAvailabilityPolicy('online'), {
    status: 'online',
    availability: 'available',
  });
  assert.equal(fleetAssignmentPolicy('online').allowed, true);
  assert.equal(fleetAssignmentPolicy('busy').allowed, false);
  assert.equal(fleetAssignmentPolicy('offline').allowed, false);
});

// ── Domain: aggregate ────────────────────────────────────────────────────────

test('reconstituteVehicle exposes publicView + availability; newVehicle defaults online', () => {
  assert.equal(reconstituteVehicle(null), null);
  const v = reconstituteVehicle({ id: 1, name: 'T', lat: 1, lng: 2, status: 'busy', extra: 'z' });
  assert.deepEqual(v.publicView(), { id: 1, name: 'T', lat: 1, lng: 2, status: 'busy' });
  assert.equal(v.availability(), 'busy');
  assert.deepEqual(newVehicle({ name: 'T', lat: 5, lng: 6 }), {
    name: 'T',
    lat: 5,
    lng: 6,
    status: 'online',
  });
});

// ── Application: orchestration over pure fakes ───────────────────────────────

function makeApp(overrides = {}) {
  const base = {
    fleetRepository: {
      listAll: async () => [{ id: 1, name: 'T', lat: 1, lng: 2, status: 'online' }],
      register: async () => 42,
      remove: async () => {},
    },
    validateCoords: () => true,
  };
  return createFleetApplication({ ...base, ...overrides });
}

test('assertPorts fails fast when a fleetRepository method is missing', () => {
  assert.throws(() => makeApp({ fleetRepository: { listAll: async () => [] } }), /fleetRepository/);
});

test('listVehicles returns the sanitized list from the repository', async () => {
  const { useCases } = makeApp();
  const r = await useCases.listVehicles();
  assert.deepEqual(r, {
    ok: true,
    value: [{ id: 1, name: 'T', lat: 1, lng: 2, status: 'online' }],
  });
});

test('registerVehicle rejects a nameless request and returns the new id on success', async () => {
  let saved = null;
  const app = makeApp({
    fleetRepository: {
      listAll: async () => [],
      register: async (name, lat, lng) => {
        saved = { name, lat, lng };
        return 77;
      },
      remove: async () => {},
    },
  });
  const bad = await app.useCases.registerVehicle(
    app.commands.registerCommand({ name: '' }).command
  );
  assert.equal(bad.code, FleetError.VEHICLE_NAME_REQUIRED);
  const ok = await app.useCases.registerVehicle(
    app.commands.registerCommand({ name: ' Downtown ' }).command
  );
  assert.deepEqual(ok, { ok: true, value: { id: 77 } });
  assert.deepEqual(saved, { name: 'Downtown', lat: DEFAULT_LAT, lng: DEFAULT_LNG });
});

test('registerVehicle rejects invalid coordinates', async () => {
  const app = makeApp({ validateCoords: () => false });
  const r = await app.useCases.registerVehicle(
    app.commands.registerCommand({ name: 'T', lat: 999, lng: 999 }).command
  );
  assert.equal(r.code, FleetError.BAD_COORDS);
});

test('removeVehicle delegates to the repository and returns ok (unconditional, legacy)', async () => {
  let removed = null;
  const app = makeApp({
    fleetRepository: {
      listAll: async () => [],
      register: async () => 1,
      remove: async (id) => {
        removed = id;
      },
    },
  });
  const r = await app.useCases.removeVehicle(app.commands.idCommand({ id: '5' }).command);
  assert.deepEqual(r, { ok: true, value: {} });
  assert.equal(removed, '5');
});
