'use strict';

/**
 * Trips commands — immutable intent messages (ADR-005 §7). The actor identity
 * always comes from the authenticated session (JWT), never the body/params
 * (IDOR-safe, matching legacy).
 */

function createTripCommand({
  actorPhone,
  pickup,
  destination,
  pickupLat,
  pickupLng,
  destLat,
  destLng,
  payment_method,
}) {
  return {
    ok: true,
    command: Object.freeze({
      actorPhone,
      pickup,
      destination,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      paymentMethod: payment_method,
    }),
  };
}

function tripIdActorCommand({ actorPhone, actorType, actorRole, actorDriverId, id }) {
  return {
    ok: true,
    command: Object.freeze({ actorPhone, actorType, actorRole, actorDriverId, tripId: Number(id) }),
  };
}

function updateStatusCommand({ actorPhone, actorType, id, status }) {
  return {
    ok: true,
    command: Object.freeze({ actorPhone, actorType, tripId: Number(id), status }),
  };
}

function rateCommand({ actorPhone, id, rating, comment }) {
  return { ok: true, command: Object.freeze({ actorPhone, tripId: Number(id), rating, comment }) };
}

function updateLocationCommand({ actorPhone, tripId, lat, lng }) {
  return { ok: true, command: Object.freeze({ actorPhone, tripId: Number(tripId), lat, lng }) };
}

function actorOnlyCommand({ actorPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone }) };
}

module.exports = {
  createTripCommand,
  tripIdActorCommand,
  updateStatusCommand,
  rateCommand,
  updateLocationCommand,
  actorOnlyCommand,
};
