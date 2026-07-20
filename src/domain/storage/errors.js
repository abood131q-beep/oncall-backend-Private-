'use strict';

/**
 * Storage error model (Phase 14.3.4) — PURE domain. Typed errors so callers can
 * branch on `err.name`/`instanceof` rather than string matching.
 */

class StorageError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'StorageError';
    if (details) this.details = details;
  }
}

class NotFoundError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'NotFoundError';
  }
}

/** Optimistic-concurrency conflict: expected version did not match the stored one. */
class ConcurrencyError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ConcurrencyError';
  }
}

class TransactionError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'TransactionError';
  }
}

class ValidationError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ValidationError';
  }
}

module.exports = {
  StorageError,
  NotFoundError,
  ConcurrencyError,
  TransactionError,
  ValidationError,
};
