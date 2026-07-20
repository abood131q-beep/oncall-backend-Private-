'use strict';

/**
 * Notifications domain — Value Objects (ADR-002 §7, ADR-005 §18).
 *
 * Pure: no I/O, no framework, no SQL, no Socket.IO. Constants and shapes are a
 * 1:1 extraction of the legacy src/routes/notifications.js. Any change is an
 * ADR amendment, not an edit here.
 */

// ── Legacy constants (device-token / push context) ───────────────────────────
const VALID_PLATFORMS = ['android', 'ios'];
const MAX_TOKEN_LENGTH = 512;
const MAX_BROADCAST = 1000;
const MAX_APP_VERSION_LENGTH = 20;

/**
 * DeliveryChannel — the platform a device token targets (push transport).
 * @returns {{ valid: true, value: 'android'|'ios' } | { valid: false }}
 */
function tryCreateChannel(platform) {
  return VALID_PLATFORMS.includes(platform) ? { valid: true, value: platform } : { valid: false };
}

/**
 * NotificationType — the category carried in a push (from `data.type` or
 * legacy record `type`). Passthrough; legacy applies no validation.
 */
function notificationType(raw) {
  return raw == null ? 'general' : String(raw);
}

/**
 * NotificationStatus — the delivery outcome vocabulary (mirrors the shape the
 * push service returns: configured send/broadcast vs skipped-when-unconfigured).
 */
const NotificationStatus = Object.freeze({
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  NOT_CONFIGURED: 'not_configured',
});

/** Read status of a stored notification record (owned by the Users surface). */
const ReadStatus = Object.freeze({ READ: 1, UNREAD: 0 });

module.exports = {
  VALID_PLATFORMS,
  MAX_TOKEN_LENGTH,
  MAX_BROADCAST,
  MAX_APP_VERSION_LENGTH,
  tryCreateChannel,
  notificationType,
  NotificationStatus,
  ReadStatus,
};
