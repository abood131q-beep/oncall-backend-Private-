'use strict';

/**
 * Notifications domain — Policies (ADR-002 §5, ADR-005 §1).
 *
 * The invariants; the Application layer asks, this module decides. Pure: no
 * I/O, no framework, no SQL. Behavior is a 1:1 extraction of the legacy
 * src/routes/notifications.js decisions.
 */

const { tryCreateChannel, MAX_TOKEN_LENGTH, MAX_BROADCAST } = require('./notificationValues');

const NotificationRejection = Object.freeze({
  TOKEN_REQUIRED: 'TOKEN_REQUIRED',
  TOKEN_TOO_LONG: 'TOKEN_TOO_LONG',
  INVALID_PLATFORM: 'INVALID_PLATFORM',
  PUSH_FIELDS_REQUIRED: 'PUSH_FIELDS_REQUIRED',
  BROADCAST_FIELDS_REQUIRED: 'BROADCAST_FIELDS_REQUIRED',
  BROADCAST_TOO_LARGE: 'BROADCAST_TOO_LARGE',
});

/**
 * DeliveryPolicy (device-token registration) — ordered exactly as legacy:
 * token present → token length → platform valid.
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
function deviceTokenPolicy(deviceToken, platform) {
  if (!deviceToken || typeof deviceToken !== 'string' || !deviceToken.trim()) {
    return { allowed: false, code: NotificationRejection.TOKEN_REQUIRED };
  }
  if (deviceToken.length > MAX_TOKEN_LENGTH) {
    return { allowed: false, code: NotificationRejection.TOKEN_TOO_LONG };
  }
  if (!tryCreateChannel(platform).valid) {
    return { allowed: false, code: NotificationRejection.INVALID_PLATFORM };
  }
  return { allowed: true };
}

/** DeliveryPolicy (single push) — phone + title + body all required. */
function pushDeliveryPolicy(phone, title, body) {
  if (!phone || !title || !body) {
    return { allowed: false, code: NotificationRejection.PUSH_FIELDS_REQUIRED };
  }
  return { allowed: true };
}

/** DeliveryPolicy (broadcast) — non-empty phones[] + title + body, ≤ 1000. */
function broadcastDeliveryPolicy(phones, title, body) {
  if (!Array.isArray(phones) || !phones.length || !title || !body) {
    return { allowed: false, code: NotificationRejection.BROADCAST_FIELDS_REQUIRED };
  }
  if (phones.length > MAX_BROADCAST) {
    return { allowed: false, code: NotificationRejection.BROADCAST_TOO_LARGE };
  }
  return { allowed: true };
}

/**
 * RetryPolicy — on a delivery failure, should the device token be pruned?
 * Models the legacy push service's invalid-token cleanup (unregistered /
 * invalid-argument FCM codes). Pure decision; the gateway performs the removal.
 */
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);
function retryPolicy(fcmCode) {
  return { pruneToken: INVALID_TOKEN_CODES.has(fcmCode), retry: false };
}

/**
 * ReadPolicy — a stored notification may be read/marked only by its owner.
 * (The notification-record surface is served by the migrated Users context;
 * this is the shared domain rule, kept here as the Notifications vocabulary.)
 */
function readPolicy(actorPhone, recordPhone) {
  return { allowed: actorPhone === recordPhone };
}

/** VisibilityPolicy — a stored notification is visible only to its owner. */
function visibilityPolicy(actorPhone, recordPhone) {
  return { visible: actorPhone === recordPhone };
}

module.exports = {
  NotificationRejection,
  deviceTokenPolicy,
  pushDeliveryPolicy,
  broadcastDeliveryPolicy,
  retryPolicy,
  readPolicy,
  visibilityPolicy,
};
