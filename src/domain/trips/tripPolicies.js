'use strict';

/**
 * Trips domain — Policies (ADR-002 §5, ADR-005 §1).
 *
 * The invariants; the Application layer asks, this module decides. Pure: no
 * I/O, no framework, no SQL. Every decision is a 1:1 extraction of the legacy
 * src/routes/taxi.js state machine and authorization rules.
 */

const { isDriverOnly, isCancellable, TripStatus } = require('./tripValues');

const TripRejection = Object.freeze({
  INVALID_STATUS: 'INVALID_STATUS',
  DRIVER_ONLY: 'DRIVER_ONLY',
  TRIP_NOT_FOUND: 'TRIP_NOT_FOUND',
  ALREADY_ACCEPTED: 'ALREADY_ACCEPTED',
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  NOT_TRIP_DRIVER_START: 'NOT_TRIP_DRIVER_START',
  NOT_TRIP_DRIVER_COMPLETE: 'NOT_TRIP_DRIVER_COMPLETE',
  NOT_CANCELLABLE: 'NOT_CANCELLABLE',
  NOT_OWNER_CANCEL: 'NOT_OWNER_CANCEL',
  NOT_TRIP_DRIVER_MISC: 'NOT_TRIP_DRIVER_MISC',
  MISSING_FIELDS: 'MISSING_FIELDS',
  BAD_PICKUP_COORDS: 'BAD_PICKUP_COORDS',
  BAD_DEST_COORDS: 'BAD_DEST_COORDS',
  RATING_RANGE: 'RATING_RANGE',
  NOT_PASSENGER_RATER: 'NOT_PASSENGER_RATER',
  NOT_DRIVER_RATER: 'NOT_DRIVER_RATER',
  ALREADY_RATED: 'ALREADY_RATED',
  NOT_COMPLETED_FOR_RATING: 'NOT_COMPLETED_FOR_RATING',
  LOCATION_FORBIDDEN: 'LOCATION_FORBIDDEN',
  ACCESS_FORBIDDEN: 'ACCESS_FORBIDDEN',
});

/** StateTransitionPolicy — DRIVER_ONLY transitions require a driver actor. */
function stateTransitionAuthorization(status, actorType) {
  if (isDriverOnly(status) && actorType !== 'driver') {
    return { allowed: false, code: TripRejection.DRIVER_ONLY };
  }
  return { allowed: true };
}

/** AcceptancePolicy — a trip may be accepted only while waiting_driver. */
function acceptancePolicy(trip) {
  if (trip.status !== TripStatus.WAITING) {
    return { allowed: false, code: TripRejection.ALREADY_ACCEPTED };
  }
  return { allowed: true };
}

/** CompletionPolicy / start — only the assigned driver. */
function assignedDriverPolicy(trip, driver, code) {
  if (!driver || trip.driver_id !== driver.id) return { allowed: false, code };
  return { allowed: true };
}

/** CancellationPolicy — cancellable state + (passenger owner OR assigned driver). */
function cancellationPolicy(trip, actorPhone, cancelDriver) {
  if (!isCancellable(trip.status)) {
    return { allowed: false, code: TripRejection.NOT_CANCELLABLE };
  }
  const isPassenger = actorPhone === trip.user_phone;
  const isAssignedDriver =
    cancelDriver !== null && trip.driver_id === (cancelDriver && cancelDriver.id);
  if (!isPassenger && !isAssignedDriver) {
    return { allowed: false, code: TripRejection.NOT_OWNER_CANCEL };
  }
  return { allowed: true, isPassenger };
}

/** AssignmentPolicy — append a rejecting driver to the exclusion list. */
function nextRejectedList(rejectedDrivers, driverId) {
  const rejected = Array.isArray(rejectedDrivers) ? [...rejectedDrivers] : [];
  rejected.push(driverId);
  return rejected;
}

/** Access (IDOR) — admin, the passenger, or the assigned driver. */
function canAccessTrip(user, trip) {
  return (
    user.role === 'admin' ||
    user.phone === trip.user_phone ||
    (user.driverId != null && user.driverId === trip.driver_id)
  );
}

/** Rating validity (ratings are a completed-trip, owner-only, once-only fact). */
function ratingPolicy({ rating, trip, actorPhone, isDriverRater, existingRating }) {
  if (!rating || rating < 1 || rating > 5) {
    return { allowed: false, code: TripRejection.RATING_RANGE };
  }
  if (isDriverRater) {
    // driver rating a passenger — handled by caller (needs driver id match)
  } else if (actorPhone !== trip.user_phone) {
    return { allowed: false, code: TripRejection.NOT_PASSENGER_RATER };
  }
  if (existingRating !== null && existingRating !== undefined) {
    return { allowed: false, code: TripRejection.ALREADY_RATED };
  }
  if (trip.status !== TripStatus.COMPLETED) {
    return { allowed: false, code: TripRejection.NOT_COMPLETED_FOR_RATING };
  }
  return { allowed: true };
}

// ── Pure computation extracted from completion ───────────────────────────────
/**
 * settleTripDistance — total route distance (km) with pickup→dest fallback.
 * @param {Function} distanceKm — injected pure haversine (getDistanceKm)
 */
function settleTripDistance(route, trip, distanceKm) {
  let totalDistKm = 0;
  for (let i = 1; i < route.length; i++) {
    totalDistKm += distanceKm(route[i - 1].lat, route[i - 1].lng, route[i].lat, route[i].lng);
  }
  if (totalDistKm < 0.1 && trip.pickup_lat && trip.dest_lat) {
    totalDistKm = distanceKm(trip.pickup_lat, trip.pickup_lng, trip.dest_lat, trip.dest_lng);
  }
  return totalDistKm;
}

function settleTripDuration(startTime, now) {
  if (!startTime) return 0;
  const diffMs = now - Number(startTime);
  if (diffMs > 0 && diffMs < 86400000) return Math.max(1, Math.round(diffMs / 60000));
  return 0;
}

/**
 * finalFare — legacy fare selection: metered if distance>0.1, else time-based,
 * else the estimate. `calculateFare` injected (fareCalculator).
 */
function finalFare(totalDistKm, durationMinutes, estimatedFare, calculateFare) {
  if (totalDistKm > 0.1) return calculateFare(totalDistKm, durationMinutes);
  if (durationMinutes > 0) return Math.round((1.0 + durationMinutes * 0.05) * 1000) / 1000;
  return estimatedFare || 1.0;
}

module.exports = {
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
};
