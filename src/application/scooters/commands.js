'use strict';

/**
 * Scooters commands — immutable intent messages (ADR-005 §7) with input
 * validation (§10). Thin by design: legacy performs minimal validation (phone
 * from JWT; bodies lightly used), so adding rejections legacy never produced
 * would be a behavior change.
 */

/** UnlockScooter { actorPhone, scooterId } */
function unlockScooterCommand({ actorPhone, scooterId }) {
  return { ok: true, command: Object.freeze({ actorPhone, scooterId }) };
}

/** EndRide { actorPhone, scooterId, endLat?, endLng? } */
function endRideCommand({ actorPhone, scooterId, endLat, endLng }) {
  return { ok: true, command: Object.freeze({ actorPhone, scooterId, endLat, endLng }) };
}

/** GetActive / GetHistory { actorPhone } — legacy ignores the path phone (JWT is truth). */
function actorOnlyCommand({ actorPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone }) };
}

/** GetScooter { scooterId } */
function getScooterCommand({ scooterId }) {
  return { ok: true, command: Object.freeze({ scooterId }) };
}

/** AddScooter { name?, scooter_code?, lat?, lng?, battery? } */
function addScooterCommand({ name, scooter_code, lat, lng, battery }) {
  return {
    ok: true,
    command: Object.freeze({ name, scooterCode: scooter_code, lat, lng, battery }),
  };
}

/** DeleteScooter { scooterId } */
function deleteScooterCommand({ scooterId }) {
  return { ok: true, command: Object.freeze({ scooterId }) };
}

module.exports = {
  unlockScooterCommand,
  endRideCommand,
  actorOnlyCommand,
  getScooterCommand,
  addScooterCommand,
  deleteScooterCommand,
};
