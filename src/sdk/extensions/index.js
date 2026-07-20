'use strict';

/**
 * Enterprise Extension SDK — public surface (Phase 14.3.1).
 *
 * The single import an extension author needs:
 *   const { Extension } = require('oncall/sdk/extensions');
 *
 * Everything is additive over the Phase-14.2 platform (ADR-017): the SDK builds
 * the same registry-compatible package shape, wires only through Ports, and is
 * imported by no hot path.
 */

const { Extension, HEALTH } = require('./Extension');
const errors = require('./errors');
const testKit = require('./testKit');

module.exports = {
  Extension,
  HEALTH,
  // Standard error model
  ExtensionError: errors.ExtensionError,
  ConfigurationError: errors.ConfigurationError,
  CapabilityError: errors.CapabilityError,
  PermissionError: errors.PermissionError,
  HookRegistrationError: errors.HookRegistrationError,
  ManifestError: errors.ManifestError,
  errors,
  // Testing SDK
  testKit,
};
