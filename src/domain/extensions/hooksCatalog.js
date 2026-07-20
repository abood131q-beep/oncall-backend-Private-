'use strict';

/**
 * hooksCatalog (Phase 14.2) — the closed set of lifecycle hook points an
 * extension may register for. Pure Domain. A manifest referencing an unknown
 * hook is rejected. Hook points mirror the platform's domain events + command
 * boundaries (ADR-002 §8).
 */

const HOOKS = Object.freeze([
  'BeforeRideRequest',
  'AfterRideCreated',
  'BeforePayment',
  'AfterPayment',
  'BeforeUnlock',
  'AfterUnlock',
  'TripStarted',
  'TripCompleted',
  'DriverApproved',
  'ScooterReturned',
  'UserRegistered',
  'OrganizationCreated',
]);

const HOOK_SET = new Set(HOOKS);
const isKnownHook = (h) => HOOK_SET.has(h);

// "Before*" hooks may influence the flow (cancel/patch); "After*"/event hooks
// are observational (their outcome never blocks the platform).
const isBlockingHook = (h) => /^Before/.test(h);

module.exports = { HOOKS, isKnownHook, isBlockingHook };
