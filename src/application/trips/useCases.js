'use strict';

/**
 * Trips use cases — Application layer (ADR-005 §5/§6).
 *
 * Validation → authorization (domain policies) → domain decision → side effects
 * via ports → typed result. A 1:1 migration of src/routes/taxi.js: identical
 * outcomes, identical ordering of security/transaction/event steps. The heavy
 * integrations (matcher, payment, Socket.IO events, push) are reused via ports.
 *
 * Results: { ok: true, value } | { ok: false, code }.
 */

const {
  TripRejection,
  stateTransitionAuthorization,
  acceptancePolicy,
  assignedDriverPolicy,
  cancellationPolicy,
  nextRejectedList,
  canAccessTrip,
  ratingPolicy,
  settleTripDistance,
  settleTripDuration,
  finalFare,
} = require('../../domain/trips/tripPolicies');
const { isValidStatus, TripStatus } = require('../../domain/trips/tripValues');

const TripsError = Object.freeze({ ...TripRejection });

function createTripsUseCases(ports) {
  const {
    tripRepository,
    driverGateway,
    matchingGateway,
    completionGateway,
    eventGateway,
    fareGateway,
    locationGateway,
    auditLog,
    formatTrip,
    safeJSON,
  } = ports;

  /** CreateTrip — validate, create, return formatted; matching dispatched after. */
  async function createTrip(command) {
    const { pickup, destination, pickupLat, pickupLng, destLat, destLng } = command;
    const validMethods = ['cash', 'wallet'];
    const paymentMethod = validMethods.includes(command.paymentMethod)
      ? command.paymentMethod
      : 'cash';
    if (!pickup || !destination) return { ok: false, code: TripsError.MISSING_FIELDS };
    if ((pickupLat || pickupLng) && !fareGateway.validateCoords(pickupLat, pickupLng)) {
      return { ok: false, code: TripsError.BAD_PICKUP_COORDS };
    }
    if ((destLat || destLng) && !fareGateway.validateCoords(destLat, destLng)) {
      return { ok: false, code: TripsError.BAD_DEST_COORDS };
    }

    let estimatedFare = 0.75;
    if (pickupLat && pickupLng && destLat && destLng) {
      const distKm = fareGateway.distanceKm(pickupLat, pickupLng, destLat, destLng);
      estimatedFare = fareGateway.estimate(distKm, Math.round(distKm * 3));
    }

    const result = await tripRepository.create(
      command.actorPhone,
      pickup,
      destination,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      estimatedFare,
      paymentMethod
    );
    const tripId = result.lastID;
    const trip = await tripRepository.findById(tripId);
    const formatted = formatTrip(trip);
    return { ok: true, value: { trip: formatted, tripId, pickupLat, pickupLng } };
  }

  /** DispatchMatching — fire-and-forget after the response (legacy ordering). */
  async function dispatchMatching({ tripId, pickupLat, pickupLng, formatted }) {
    const nearest = await matchingGateway.findNearestDriver(pickupLat, pickupLng);
    if (nearest) {
      await matchingGateway.sendRequestToDriver(tripId, nearest);
      auditLog.info(`Nearest driver → trip #${tripId}`);
    } else {
      auditLog.warn(`No drivers available for trip #${tripId}`);
      eventGateway.noDriver(formatted, tripId);
    }
  }

  /** RejectTrip — driver declines; reassign or mark no_driver. */
  async function rejectTrip(command) {
    const trip = await tripRepository.findById(command.tripId);
    if (!trip || trip.status !== TripStatus.WAITING) return { ok: false, code: 'REJECT_INVALID' };
    const driver = await driverGateway.findByPhone(command.actorPhone);
    if (!driver) return { ok: false, code: 'REJECT_NO_DRIVER' };

    matchingGateway.clearTimer(command.tripId);
    const rejected = nextRejectedList(safeJSON(trip.rejected_drivers, []), driver.id);
    await tripRepository.setRejectedDrivers(command.tripId, rejected);
    auditLog.info(`Driver ${driver.name} rejected trip #${command.tripId}`);

    const next = await matchingGateway.findNearestDriver(
      trip.pickup_lat,
      trip.pickup_lng,
      rejected
    );
    if (next) {
      await matchingGateway.sendRequestToDriver(command.tripId, next);
      return { ok: true, value: { reassigned: true } };
    }
    await tripRepository.setStatus(command.tripId, TripStatus.NO_DRIVER);
    eventGateway.noDriver(formatTrip(trip), command.tripId);
    return { ok: true, value: { reassigned: false } };
  }

  /** Lists (driver / requests / passenger). */
  async function listDriverTrips(command) {
    const driver = await driverGateway.findByPhone(command.actorPhone);
    const trips = driver
      ? await tripRepository.findForDriver(driver.id, driver.name, 50)
      : await tripRepository.findAll(100);
    return { ok: true, value: { trips: trips.map(formatTrip) } };
  }
  async function listRequests() {
    const trips = await tripRepository.findWaiting(100);
    return { ok: true, value: { trips: trips.map(formatTrip) } };
  }
  async function listPassengerTrips(command) {
    const trips = await tripRepository.findByPassenger(command.actorPhone);
    return { ok: true, value: { trips: trips.map(formatTrip) } };
  }

  /** UpdateTripStatus — the lifecycle orchestrator (accept/arrive/in_progress/complete/cancel). */
  async function updateTripStatus(command) {
    const { tripId, status, actorPhone, actorType } = command;
    if (!isValidStatus(status)) return { ok: false, code: TripsError.INVALID_STATUS };

    const authz = stateTransitionAuthorization(status, actorType);
    if (!authz.allowed) return { ok: false, code: authz.code };

    const trip = await tripRepository.findById(tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };

    if (status === TripStatus.ACCEPTED) {
      const gate = acceptancePolicy(trip);
      if (!gate.allowed) return { ok: false, code: gate.code };
      const driver = await driverGateway.findByPhone(actorPhone);
      if (!driver) return { ok: false, code: TripsError.DRIVER_NOT_FOUND };
      const taxi = await driverGateway.findTaxi(driver.id);
      const accept = await tripRepository.acceptByDriver(
        tripId,
        driver.id,
        driver.name,
        taxi ? taxi.lat : null,
        taxi ? taxi.lng : null
      );
      if (accept.changes === 0) return { ok: false, code: TripsError.ALREADY_ACCEPTED };
      if (taxi) await driverGateway.setTaxiBusy(taxi.id);
      matchingGateway.clearTimer(tripId);
    } else if (status === TripStatus.IN_PROGRESS) {
      const driver = await driverGateway.findByPhone(actorPhone);
      const gate = assignedDriverPolicy(trip, driver, TripsError.NOT_TRIP_DRIVER_START);
      if (!gate.allowed) return { ok: false, code: gate.code };
      await tripRepository.startTrip(tripId, Date.now());
    } else if (status === TripStatus.COMPLETED) {
      const driver = await driverGateway.findByPhone(actorPhone);
      const gate = assignedDriverPolicy(trip, driver, TripsError.NOT_TRIP_DRIVER_COMPLETE);
      if (!gate.allowed) return { ok: false, code: gate.code };
      const route = safeJSON(trip.route, []);
      const totalDistKm = settleTripDistance(route, trip, fareGateway.distanceKm);
      const durationMinutes = settleTripDuration(trip.start_time, Date.now());
      const fare = finalFare(
        totalDistKm,
        durationMinutes,
        trip.estimated_fare,
        fareGateway.calculate
      );
      await tripRepository.completeTrip(tripId, fare, totalDistKm, durationMinutes);
      if (trip.user_phone) await completionGateway.settle(tripId, trip, fare);
      if (trip.driver_id) await driverGateway.resetTaxiOnline(trip.driver_id);
    } else if (status === TripStatus.CANCELLED) {
      const isPassenger = actorPhone === trip.user_phone;
      const cancelDriver = isPassenger ? null : await driverGateway.findByPhone(actorPhone);
      const gate = cancellationPolicy(trip, actorPhone, cancelDriver);
      if (!gate.allowed) return { ok: false, code: gate.code };
      await tripRepository.setStatus(tripId, TripStatus.CANCELLED);
      if (trip.driver_id) await driverGateway.resetTaxiOnline(trip.driver_id);
    } else {
      // arrived and others — only the assigned driver
      const driver = await driverGateway.findByPhone(actorPhone);
      const gate = assignedDriverPolicy(trip, driver, TripsError.NOT_TRIP_DRIVER_MISC);
      if (!gate.allowed) return { ok: false, code: gate.code };
      await tripRepository.setStatus(tripId, status);
    }

    const updated = await tripRepository.findById(tripId);
    const formatted = formatTrip(updated);
    eventGateway.statusUpdated(formatted, tripId, status, updated);
    if (status === TripStatus.ACCEPTED && updated.user_phone) {
      eventGateway.accepted(formatted, tripId, updated.user_phone);
    }
    eventGateway.pushStatusChange(updated, status, tripId);
    return { ok: true, value: { trip: formatted } };
  }

  /** RateTrip — passenger rates driver; recomputes driver average; notifies. */
  async function rateTrip(command) {
    const { tripId, rating, comment, actorPhone } = command;
    if (!rating || rating < 1 || rating > 5) return { ok: false, code: TripsError.RATING_RANGE };
    const trip = await tripRepository.findById(tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };
    const gate = ratingPolicy({
      rating,
      trip,
      actorPhone,
      isDriverRater: false,
      existingRating: trip.rating,
    });
    if (!gate.allowed) return { ok: false, code: gate.code };

    await tripRepository.rateByPassenger(tripId, rating, comment);
    if (trip.driver_id) {
      const driverTrips = await tripRepository.getRatingsByDriver(trip.driver_id);
      if (driverTrips.length > 0) {
        const avg = driverTrips.reduce((s, t) => s + t.rating, 0) / driverTrips.length;
        await driverGateway.updateRating(
          trip.driver_id,
          Math.round(avg * 10) / 10,
          driverTrips.length
        );
      }
      const driver = await driverGateway.findById(trip.driver_id);
      if (driver) {
        await eventGateway.tripNotify(
          driver.phone,
          `${'⭐'.repeat(rating)} تقييم جديد`,
          `حصلت على ${rating}/5 نجوم${comment ? ': ' + comment : ''}`,
          'rating_received',
          tripId
        );
      }
    }
    return { ok: true, value: { rated: true } };
  }

  /** RatePassenger — driver rates passenger; notifies. */
  async function ratePassenger(command) {
    const { tripId, rating, comment, actorPhone } = command;
    if (!rating || rating < 1 || rating > 5) return { ok: false, code: 'RATING_BARE' };
    const trip = await tripRepository.findById(tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };
    const driver = await driverGateway.findByPhone(actorPhone);
    if (!driver || trip.driver_id !== driver.id)
      return { ok: false, code: TripsError.NOT_DRIVER_RATER };
    if (trip.driver_rating !== null && trip.driver_rating !== undefined) {
      return { ok: false, code: TripsError.ALREADY_RATED };
    }
    if (trip.status !== TripStatus.COMPLETED)
      return { ok: false, code: TripsError.NOT_COMPLETED_FOR_RATING };

    await tripRepository.rateByDriver(tripId, rating, comment);
    if (trip.user_phone) {
      await eventGateway.tripNotify(
        trip.user_phone,
        `${'⭐'.repeat(rating)} تقييمك من السائق`,
        `السائق قيّمك ${rating}/5 نجوم${comment ? ': ' + comment : ''}`,
        'rating_received',
        tripId
      );
    }
    return { ok: true, value: { rated: true } };
  }

  /** UpdateLocation (HTTP fallback) — assigned driver only; live stats + event. */
  async function updateLocation(command) {
    const { tripId, lat, lng, actorPhone } = command;
    const trip = await tripRepository.findById(tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };
    const driver = await driverGateway.findByPhone(actorPhone);
    if (!driver || trip.driver_id !== driver.id)
      return { ok: false, code: TripsError.LOCATION_FORBIDDEN };

    const route = safeJSON(trip.route, []);
    if (trip.status === TripStatus.IN_PROGRESS) route.push({ lat, lng, time: Date.now() });
    await tripRepository.updateLocation(tripId, lat, lng, route);
    if (trip.driver_id) await locationGateway.updateTaxiLocation(lat, lng, trip.driver_id);

    let liveStats = null;
    if (trip.status === TripStatus.IN_PROGRESS && route.length > 1) {
      const totalDist = settleTripDistance(route, trip, fareGateway.distanceKm);
      const durationMin =
        settleTripDuration(trip.start_time, Date.now()) === 0
          ? 0
          : Math.round((Date.now() - Number(trip.start_time)) / 60000);
      liveStats = {
        distanceKm: Math.round(totalDist * 1000) / 1000,
        durationMinutes: durationMin,
        currentFare: fareGateway.calculate(totalDist, durationMin),
      };
    }
    eventGateway.driverMoved(tripId, lat, lng, liveStats, trip.status);
    return { ok: true, value: { liveStats } };
  }

  /** GetTripLocation — access-controlled snapshot with live stats. */
  async function getTripLocation(command) {
    const trip = await tripRepository.findById(command.tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };
    if (
      !canAccessTrip(
        { role: command.actorRole, phone: command.actorPhone, driverId: command.actorDriverId },
        trip
      )
    ) {
      return { ok: false, code: TripsError.ACCESS_FORBIDDEN };
    }
    const route = safeJSON(trip.route, []);
    const distanceKm = settleTripDistance(route, { pickup_lat: null }, fareGateway.distanceKm);
    let durationMinutes = 0;
    if (trip.start_time) {
      const diffMs = Date.now() - Number(trip.start_time);
      if (diffMs > 0 && diffMs < 86400000) durationMinutes = Math.round(diffMs / 60000);
    }
    return {
      ok: true,
      value: {
        trip,
        route,
        liveStats:
          trip.status === TripStatus.IN_PROGRESS
            ? {
                distanceKm: Math.round(distanceKm * 1000) / 1000,
                durationMinutes,
                currentFare: fareGateway.calculate(distanceKm, durationMinutes),
              }
            : null,
      },
    };
  }

  /** GetTrip — access-controlled single trip. */
  async function getTrip(command) {
    const trip = await tripRepository.findById(command.tripId);
    if (!trip) return { ok: false, code: TripsError.TRIP_NOT_FOUND };
    if (
      !canAccessTrip(
        { role: command.actorRole, phone: command.actorPhone, driverId: command.actorDriverId },
        trip
      )
    ) {
      return { ok: false, code: TripsError.ACCESS_FORBIDDEN };
    }
    return { ok: true, value: { trip: formatTrip(trip) } };
  }

  /** DeleteAll (admin). */
  async function deleteAllTrips() {
    await tripRepository.deleteAll();
    await locationGateway.resetTaxis();
    return { ok: true, value: {} };
  }

  return {
    createTrip,
    dispatchMatching,
    rejectTrip,
    listDriverTrips,
    listRequests,
    listPassengerTrips,
    updateTripStatus,
    rateTrip,
    ratePassenger,
    updateLocation,
    getTripLocation,
    getTrip,
    deleteAllTrips,
  };
}

module.exports = { createTripsUseCases, TripsError };
