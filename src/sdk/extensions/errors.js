'use strict';

/**
 * Extension SDK — standard error model (Phase 14.3.1).
 * Every SDK-surfaced failure is one of these typed errors, so hosts and tests
 * can branch on `err.name`/`instanceof` rather than string matching.
 * ManifestError is re-exported from the domain so there is ONE manifest error
 * type across platform + SDK.
 */

const { ManifestError } = require('../../domain/extensions/manifest');

class ExtensionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ExtensionError';
    if (details) this.details = details;
  }
}

class ConfigurationError extends ExtensionError {
  constructor(message, details) {
    super(message, details);
    this.name = 'ConfigurationError';
  }
}

class CapabilityError extends ExtensionError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CapabilityError';
  }
}

class PermissionError extends ExtensionError {
  constructor(message, details) {
    super(message, details);
    this.name = 'PermissionError';
  }
}

class HookRegistrationError extends ExtensionError {
  constructor(message, details) {
    super(message, details);
    this.name = 'HookRegistrationError';
  }
}

module.exports = {
  ExtensionError,
  ConfigurationError,
  CapabilityError,
  PermissionError,
  HookRegistrationError,
  ManifestError, // re-export: single manifest error type platform-wide
};
