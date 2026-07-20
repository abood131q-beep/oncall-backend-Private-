'use strict';

/**
 * Users commands — immutable intent messages (ADR-005 §7) with input
 * validation (§10 kind 1). Validation answers only "is this a coherent
 * request?"; business legality is decided by the Domain, never here.
 *
 * STRANGLER FIDELITY: the legacy src/routes/users.js performs almost no input
 * validation (the authenticated phone comes from the JWT; bodies are lightly
 * used). These factories therefore stay deliberately thin — adding rejections
 * the legacy path never produced would be a behavior change.
 */

/**
 * UpdateProfile { name? } — actor phone comes from the authenticated session,
 * never the body (IDOR-safe, matching legacy). `name` is passed through
 * exactly as legacy does (undefined allowed).
 */
function updateProfileCommand({ actorPhone, name }) {
  return {
    ok: true,
    command: Object.freeze({ actorPhone, name }),
  };
}

/**
 * GetBalance { actorPhone, targetPhone } — targetPhone is the path param the
 * legacy route authorizes against (must equal actorPhone).
 */
function getBalanceCommand({ actorPhone, targetPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone, targetPhone }) };
}

/** GetActivity { actorPhone } — legacy ignores the path phone (JWT is truth). */
function getActivityCommand({ actorPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone }) };
}

/** ListNotifications { actorPhone } — legacy ignores the path phone. */
function listNotificationsCommand({ actorPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone }) };
}

/** MarkNotificationsRead { actorPhone } — legacy ignores the path phone. */
function markNotificationsReadCommand({ actorPhone }) {
  return { ok: true, command: Object.freeze({ actorPhone }) };
}

/**
 * SubmitReport { actorPhone, type?, description?, tripId? } — mirrors legacy
 * `type || 'general'`, `trip_id || null`; description passed through.
 */
function submitReportCommand({ actorPhone, type, description, tripId }) {
  return {
    ok: true,
    command: Object.freeze({
      actorPhone,
      type: type || undefined,
      description,
      tripId: tripId || null,
    }),
  };
}

module.exports = {
  updateProfileCommand,
  getBalanceCommand,
  getActivityCommand,
  listNotificationsCommand,
  markNotificationsReadCommand,
  submitReportCommand,
};
