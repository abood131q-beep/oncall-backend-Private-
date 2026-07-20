'use strict';

/**
 * Scooter — the Scooters bounded-context Aggregate Root (ADR-002 §4).
 *
 * Reconstituted from a persistence snapshot; the single consistency boundary
 * for a scooter's status/battery/rider. Pure: no I/O, no framework, no SQL
 * (ADR-005 §18). Persistence shape stays in Infrastructure.
 */

const { ScooterStatus, isAvailable, scooterCode } = require('./scooterValues');

/** Public projection — the exact fields legacy `sanitizeScooter` exposes. */
const PUBLIC_FIELDS = ['id', 'name', 'scooter_code', 'lat', 'lng', 'battery', 'status'];

function publicView(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = row[f];
  return out;
}

function reconstituteScooter(snapshot) {
  return new Scooter(snapshot || {});
}

class Scooter {
  constructor(row) {
    this._id = row.id;
    this._status = row.status;
    this._battery = row.battery;
    this._code = scooterCode(row.scooter_code);
    this._riderPhone = row.current_user_phone;
    this._rideStart = row.ride_start_time;
  }

  get id() {
    return this._id;
  }
  get status() {
    return this._status;
  }
  get battery() {
    return this._battery;
  }

  isAvailable() {
    return isAvailable(this._status);
  }

  isRiddenBy(phone) {
    return this._riderPhone === phone;
  }
}

module.exports = { Scooter, reconstituteScooter, publicView, ScooterStatus, PUBLIC_FIELDS };
