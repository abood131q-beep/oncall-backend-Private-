'use strict';

/**
 * capabilities & permissions vocabulary (Phase 14.2). Pure Domain.
 *
 * Extensions IMPLEMENT capabilities instead of modifying platform code, and are
 * granted PERMISSIONS to reach host ports. Both vocabularies are closed sets so
 * a manifest cannot invent an unrecognized capability/permission.
 */

// Capability kinds an extension may provide (ADR-002 provider seams).
const CAPABILITIES = Object.freeze([
  'RidePricing',
  'PaymentProvider',
  'VehicleProvider',
  'NotificationProvider',
  'TelemetryProvider',
  'IdentityProvider',
  'StorageProvider',
  'AIProvider',
  'MapsProvider',
  'DispatchProvider',
]);

// Permissions gate access to host resources. Default posture: DENY everything
// not explicitly listed here AND granted in the manifest (§4 sandbox).
const PERMISSIONS = Object.freeze([
  'read:trips',
  'read:users',
  'read:drivers',
  'read:vehicles',
  'read:pricing',
  'write:pricing',
  'read:config',
  'publish:events',
  'subscribe:events',
  'net:outbound',
  'storage:read',
  'storage:write',
  'secrets:read',
]);

const CAP_SET = new Set(CAPABILITIES);
const PERM_SET = new Set(PERMISSIONS);

const isKnownCapability = (c) => CAP_SET.has(c);
const isKnownPermission = (p) => PERM_SET.has(p);

module.exports = {
  CAPABILITIES,
  PERMISSIONS,
  isKnownCapability,
  isKnownPermission,
};
