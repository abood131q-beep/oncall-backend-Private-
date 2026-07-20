'use strict';

/**
 * Trip — the Trips bounded-context Aggregate Root (ADR-002 §4).
 *
 * Reconstituted from a persistence snapshot; the single consistency boundary for
 * a ride's lifecycle (status, rider, driver, fare). Pure: no I/O, no framework,
 * no SQL (ADR-005 §18). Persistence shape and formatting stay in Infrastructure.
 */

const { TripStatus } = require('./tripValues');

function reconstituteTrip(snapshot) {
  return new Trip(snapshot || {});
}

class Trip {
  constructor(row) {
    this._id = row.id;
    this._status = row.status;
    this._userPhone = row.user_phone;
    this._driverId = row.driver_id;
  }

  get id() {
    return this._id;
  }
  get status() {
    return this._status;
  }

  isWaiting() {
    return this._status === TripStatus.WAITING;
  }
  isCompleted() {
    return this._status === TripStatus.COMPLETED;
  }
  belongsToPassenger(phone) {
    return this._userPhone === phone;
  }
  isDrivenBy(driverId) {
    return this._driverId != null && this._driverId === driverId;
  }
}

module.exports = { Trip, reconstituteTrip };
