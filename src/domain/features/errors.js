'use strict';

/**
 * Feature Flag Kernel error model (Phase 15.0 / ADR-029) — PURE domain. Typed
 * errors so callers branch on `err.name`/`instanceof` rather than string matching.
 */

class FeatureError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FeatureError';
    if (details) this.details = details;
  }
}

class FeatureValidationError extends FeatureError {
  constructor(message, details) {
    super(message, details);
    this.name = 'FeatureValidationError';
  }
}

/** Requested flag does not exist in the namespace. */
class FeatureNotFoundError extends FeatureError {
  constructor(message, details) {
    super(message, details);
    this.name = 'FeatureNotFoundError';
  }
}

/** Evaluation could not be performed (bad context / malformed rule). */
class EvaluationError extends FeatureError {
  constructor(message, details) {
    super(message, details);
    this.name = 'EvaluationError';
  }
}

/** A stored definition does not match its checksum (tamper/corruption). */
class IntegrityError extends FeatureError {
  constructor(message, details) {
    super(message, details);
    this.name = 'IntegrityError';
  }
}

module.exports = {
  FeatureError,
  FeatureValidationError,
  FeatureNotFoundError,
  EvaluationError,
  IntegrityError,
};
