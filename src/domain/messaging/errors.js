'use strict';

/**
 * Messaging error model (Phase 14.5 / ADR-024) — PURE domain. Typed errors so
 * callers branch on `err.name`/`instanceof` rather than string matching.
 */

class MessagingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MessagingError';
    if (details) this.details = details;
  }
}

class MessageValidationError extends MessagingError {
  constructor(message, details) {
    super(message, details);
    this.name = 'MessageValidationError';
  }
}

/** No subscriber for a point-to-point / request destination. */
class NoSubscriberError extends MessagingError {
  constructor(message, details) {
    super(message, details);
    this.name = 'NoSubscriberError';
  }
}

/** A request/reply exchange exceeded its timeout. */
class RequestTimeoutError extends MessagingError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RequestTimeoutError';
  }
}

module.exports = { MessagingError, MessageValidationError, NoSubscriberError, RequestTimeoutError };
