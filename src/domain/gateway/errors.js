'use strict';

/**
 * API Gateway Kernel error model (Phase 15.6 / ADR-035) — PURE domain. Typed errors
 * so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class GatewayError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GatewayError';
    if (details) this.details = details;
  }
}

class GatewayValidationError extends GatewayError {
  constructor(message, details) {
    super(message, details);
    this.name = 'GatewayValidationError';
  }
}

/** No route matched the request (method/path/version). */
class RouteNotFoundError extends GatewayError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RouteNotFoundError';
  }
}

/** A request was rejected by gateway policy (auth/policy/rate-limit/feature/timeout). */
class GatewayRejectedError extends GatewayError {
  constructor(message, reason, details) {
    super(message, details);
    this.name = 'GatewayRejectedError';
    this.reason = reason || 'rejected';
  }
}

/** A stored route does not match its checksum (tamper/corruption). */
class IntegrityError extends GatewayError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  GatewayError,
  GatewayValidationError,
  RouteNotFoundError,
  GatewayRejectedError,
  IntegrityError,
};
