'use strict';

/**
 * Trips slice tests — proves the migrated Application + Domain layers reproduce
 * the legacy src/routes/taxi.js behavior with pure fakes (no transport, no
 * storage, no framework, no Socket.IO — the layering promise, verified).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stateTransitionAuthorization,
  acceptancePolicy,
  cancellationPolicy,
  canAccessTrip,
  ratingPolicy,
  settleTripDistance,
  settleTripDuration,
  finalFare,
  TripRejection,
} = require('../../src/domain/trips/tripPolicies');
const { isValidStatus, isCancellable } = require('../../src/domain/trips/tripValues');
const { createTripsApplication, TripsError } = require('../../src/application/trips');

// ── Domain ───────────────────────────────────────────────────────────────────

test('status VO: validity + driver-only + cancellable sets', () => {
  assert.equal(isValidStatus('accepted'), true);
  assert.equal(isValidStatus('flying'), false);
  assert.equal(isCancellable('completed'), false);
  assert.equal(isCancellable('accepted'), true);
});

test('stateTransitionAuthorization: driver-only transitions need a driver', () => {
  assert.equal(
    stateTransitionAuthorization('completed', 'passenger').code,
    TripRejection.DRIVER_ONLY
  );
  assert.deepEqual(stateTransitionAuthorization('completed', 'driver'), { allowed: true });
  assert.deepEqual(stateTransitionAuthorization('cancelled', 'passenger'), { allowed: true });
});

test('acceptancePolicy: only waiting_driver may be accepted', () => {
  assert.deepEqual(acceptancePolicy({ status: 'waiting_driver' }), { allowed: true });
  assert.equal(acceptancePolicy({ status: 'accepted' }).code, TripRejection.ALREADY_ACCEPTED);
});

test('cancellationPolicy: state + owner/driver', () => {
  const trip = { status: 'accepted', user_phone: 'p', driver_id: 7 };
  assert.equal(cancellationPolicy(trip, 'p', null).allowed, true);
  assert.equal(cancellationPolicy(trip, 'other', null).code, TripRejection.NOT_OWNER_CANCEL);
  assert.equal(cancellationPolicy(trip, 'other', { id: 7 }).allowed, true);
  assert.equal(
    cancellationPolicy({ status: 'completed', user_phone: 'p' }, 'p', null).code,
    TripRejection.NOT_CANCELLABLE
  );
});

test('canAccessTrip: admin / owner / assigned driver', () => {
  const trip = { user_phone: 'p', driver_id: 7 };
  assert.equal(canAccessTrip({ role: 'admin' }, trip), true);
  assert.equal(canAccessTrip({ phone: 'p' }, trip), true);
  assert.equal(canAccessTrip({ driverId: 7 }, trip), true);
  assert.equal(canAccessTrip({ phone: 'x', driverId: 9 }, trip), false);
});

test('ratingPolicy: range, ownership, once-only, completed', () => {
  const trip = { status: 'completed', user_phone: 'p' };
  assert.equal(
    ratingPolicy({ rating: 9, trip, actorPhone: 'p', existingRating: null }).code,
    TripRejection.RATING_RANGE
  );
  assert.equal(
    ratingPolicy({ rating: 5, trip, actorPhone: 'x', existingRating: null }).code,
    TripRejection.NOT_PASSENGER_RATER
  );
  assert.equal(
    ratingPolicy({ rating: 5, trip, actorPhone: 'p', existingRating: 4 }).code,
    TripRejection.ALREADY_RATED
  );
  assert.equal(
    ratingPolicy({
      rating: 5,
      trip: { status: 'accepted', user_phone: 'p' },
      actorPhone: 'p',
      existingRating: null,
    }).code,
    TripRejection.NOT_COMPLETED_FOR_RATING
  );
  assert.deepEqual(ratingPolicy({ rating: 5, trip, actorPhone: 'p', existingRating: null }), {
    allowed: true,
  });
});

test('settle compute: distance fallback, duration, final fare selection', () => {
  const dist = (a, b, c, d) => Math.abs(c - a) + Math.abs(d - b);
  const route = [
    { lat: 0, lng: 0 },
    { lat: 1, lng: 0 },
    { lat: 2, lng: 0 },
  ];
  assert.equal(settleTripDistance(route, { pickup_lat: null }, dist), 2);
  // fallback when route distance < 0.1 and pickup/dest present (non-zero, matching
  // the legacy truthy guard: pickup_lat=0 would be falsy and skip the fallback)
  assert.equal(
    settleTripDistance([], { pickup_lat: 1, pickup_lng: 0, dest_lat: 4, dest_lng: 0 }, dist),
    3
  );
  assert.equal(settleTripDuration(null, Date.now()), 0);
  assert.equal(settleTripDuration(Date.now() - 5 * 60000, Date.now()), 5);
  assert.equal(
    finalFare(0.05, 0, 0.9, () => 99),
    0.9
  ); // estimate path
  assert.equal(
    finalFare(2, 4, 0, (d, m) => d + m),
    6
  ); // metered path
});

// ── Application ──────────────────────────────────────────────────────────────

function makeApp() {
  const trips = new Map();
  let seq = 0;
  const events = [];
  const noop = () => {};
  const ports = {
    tripRepository: {
      findById: async (id) => trips.get(Number(id)),
      findAll: async () => [...trips.values()],
      findWaiting: async () => [...trips.values()].filter((t) => t.status === 'waiting_driver'),
      findForDriver: async () => [...trips.values()],
      findByPassenger: async (p) => [...trips.values()].filter((t) => t.user_phone === p),
      create: async (phone, pickup, destination) => {
        const id = ++seq;
        trips.set(id, {
          id,
          user_phone: phone,
          pickup,
          destination,
          status: 'waiting_driver',
          route: '[]',
        });
        return { lastID: id };
      },
      assignDriver: noop,
      setStatus: async (id, status) => (trips.get(Number(id)).status = status),
      setRejectedDrivers: noop,
      acceptByDriver: async (id, driverId, name) => {
        const t = trips.get(Number(id));
        if (t.status !== 'waiting_driver') return { changes: 0 };
        t.status = 'accepted';
        t.driver_id = driverId;
        t.driver_name = name;
        return { changes: 1 };
      },
      startTrip: async (id) => (trips.get(Number(id)).status = 'in_progress'),
      completeTrip: async (id) => (trips.get(Number(id)).status = 'completed'),
      updateLocation: noop,
      rateByPassenger: async (id, r) => (trips.get(Number(id)).rating = r),
      getRatingsByDriver: async () => [{ rating: 5 }],
      rateByDriver: async (id, r) => (trips.get(Number(id)).driver_rating = r),
      deleteAll: async () => trips.clear(),
    },
    driverGateway: {
      findByPhone: async (p) => (p === 'drv' ? { id: 7, name: 'D', phone: 'drv' } : null),
      findById: async () => ({ id: 7, phone: 'drv' }),
      findTaxi: async () => ({ id: 1, lat: 1, lng: 2 }),
      setTaxiBusy: noop,
      resetTaxiOnline: noop,
      updateRating: noop,
    },
    matchingGateway: {
      findNearestDriver: async () => null,
      sendRequestToDriver: noop,
      clearTimer: noop,
    },
    completionGateway: { settle: async () => events.push('settle') },
    eventGateway: {
      statusUpdated: () => events.push('statusUpdated'),
      noDriver: noop,
      accepted: () => events.push('accepted'),
      driverMoved: noop,
      pushStatusChange: noop,
      tripNotify: async () => {},
    },
    fareGateway: {
      estimate: () => 1,
      calculate: () => 1,
      distanceKm: () => 0,
      validateCoords: (lat, lng) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180,
    },
    locationGateway: { updateTaxiLocation: noop, resetTaxis: noop },
    auditLog: { info: noop, warn: noop, error: noop },
    formatTrip: (t) => ({ ...t, formatted: true }),
    safeJSON: (s, f) => (s === '[]' ? [] : f),
  };
  return { app: createTripsApplication(ports), trips, events };
}

test('createTrip: validation + create returns formatted trip', async () => {
  const { app } = makeApp();
  const miss = await app.useCases.createTrip(
    app.commands.createTripCommand({ actorPhone: 'p', pickup: 'A' }).command
  );
  assert.equal(miss.code, TripsError.MISSING_FIELDS);
  const ok = await app.useCases.createTrip(
    app.commands.createTripCommand({ actorPhone: 'p', pickup: 'A', destination: 'B' }).command
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.trip.formatted, true);
});

test('updateTripStatus: full lifecycle accept→in_progress→completed', async () => {
  const { app, events } = makeApp();
  const c = await app.useCases.createTrip(
    app.commands.createTripCommand({ actorPhone: 'p', pickup: 'A', destination: 'B' }).command
  );
  const id = c.value.tripId;
  const acc = await app.useCases.updateTripStatus(
    app.commands.updateStatusCommand({
      actorPhone: 'drv',
      actorType: 'driver',
      id,
      status: 'accepted',
    }).command
  );
  assert.equal(acc.ok, true);
  assert.ok(events.includes('accepted'));
  const done = await app.useCases.updateTripStatus(
    app.commands.updateStatusCommand({
      actorPhone: 'drv',
      actorType: 'driver',
      id,
      status: 'completed',
    }).command
  );
  assert.equal(done.ok, true);
  assert.ok(events.includes('settle')); // payment reused inside completion
});

test('updateTripStatus: passenger cannot drive a driver-only transition', async () => {
  const { app } = makeApp();
  const c = await app.useCases.createTrip(
    app.commands.createTripCommand({ actorPhone: 'p', pickup: 'A', destination: 'B' }).command
  );
  const r = await app.useCases.updateTripStatus(
    app.commands.updateStatusCommand({
      actorPhone: 'p',
      actorType: 'passenger',
      id: c.value.tripId,
      status: 'accepted',
    }).command
  );
  assert.equal(r.code, TripsError.DRIVER_ONLY);
});

test('ports: composition fails fast when a port is incomplete', () => {
  assert.throws(() => createTripsApplication({ tripRepository: {} }));
});
