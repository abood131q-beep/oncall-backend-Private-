'use strict';

/**
 * Notification Kernel error model (Phase 15.1 / ADR-030) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 * This is the NEW Notification KERNEL, distinct from the app's notifications
 * bounded context.
 */

class NotificationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'NotificationError';
    if (details) this.details = details;
  }
}

class NotificationValidationError extends NotificationError {
  constructor(message, details) {
    super(message, details);
    this.name = 'NotificationValidationError';
  }
}

/** Requested notification does not exist in the namespace. */
class NotificationNotFoundError extends NotificationError {
  constructor(message, details) {
    super(message, details);
    this.name = 'NotificationNotFoundError';
  }
}

/** No channel/provider registered for the requested channel. */
class ChannelError extends NotificationError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ChannelError';
  }
}

/** Delivery attempt failed (provider rejected / errored). */
class DeliveryError extends NotificationError {
  constructor(message, details) {
    super(message, details);
    this.name = 'DeliveryError';
  }
}

/** A stored notification does not match its checksum (tamper/corruption). */
class IntegrityError extends NotificationError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  NotificationError,
  NotificationValidationError,
  NotificationNotFoundError,
  ChannelError,
  DeliveryError,
  IntegrityError,
};
