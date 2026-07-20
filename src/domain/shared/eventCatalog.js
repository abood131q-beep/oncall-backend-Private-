'use strict';

/**
 * eventCatalog — the frozen registry of canonical Domain Event contracts
 * (Phase 14.1 review #2, ADR-006 §6 "meaning fixed by (type,version)").
 *
 * Each entry is an immutable contract: a `(type, version)` pair with its owning
 * producer and the required payload keys. Contracts NEVER change meaning: a
 * change is a NEW version entry, never an edit — old versions remain forever so
 * historical events stay interpretable (ADR-004 immutability).
 *
 * Pure: no I/O, no framework. `defineEvent` validates a candidate against the
 * catalog so producers cannot emit an unregistered or malformed contract.
 */

const { createDomainEvent, follows } = require('./DomainEvent');

// type -> { [version]: { producer, required: string[] } }
const CATALOG = Object.freeze({
  // Mobility
  TripRequested: { 1: { producer: 'trips', required: ['bookingRef', 'cityRef'] } },
  TripAccepted: { 1: { producer: 'trips', required: ['tripRef', 'driverRef'] } },
  TripStarted: { 1: { producer: 'trips', required: ['tripRef'] } },
  TripCompleted: { 1: { producer: 'trips', required: ['tripRef', 'fareRef'] } },
  TripCancelled: { 1: { producer: 'trips', required: ['tripRef', 'cancelledBy'] } },
  ScooterUnlocked: { 1: { producer: 'scooters', required: ['scooterRef', 'userRef'] } },
  RideEnded: { 1: { producer: 'scooters', required: ['rideRef'] } },
  // Commerce
  PaymentCompleted: { 1: { producer: 'payments', required: ['paymentRef', 'tripRef'] } },
  PaymentFailed: { 1: { producer: 'payments', required: ['paymentRef', 'reason'] } },
  RefundIssued: { 1: { producer: 'payments', required: ['paymentRef', 'amount'] } },
  WalletCredited: { 1: { producer: 'wallet', required: ['walletRef', 'amount'] } },
  // Identity / Drivers
  UserRegistered: { 1: { producer: 'identity', required: ['userRef'] } },
  DriverApproved: { 1: { producer: 'drivers', required: ['driverRef'] } },
  DriverSuspended: { 1: { producer: 'drivers', required: ['driverRef'] } },
});

function isRegistered(type, version = 1) {
  return Boolean(CATALOG[type] && CATALOG[type][version]);
}

function contractOf(type, version = 1) {
  return isRegistered(type, version) ? CATALOG[type][version] : null;
}

function listContracts() {
  const out = [];
  for (const [type, versions] of Object.entries(CATALOG)) {
    for (const v of Object.keys(versions)) out.push(`${type} v${v}`);
  }
  return out;
}

/**
 * defineEvent — create a catalog-validated Domain Event. Rejects unregistered
 * types/versions, wrong producer, and missing required payload keys.
 * @param {object} spec { type, version?, producer, payload, subject?, correlationId?, causationId? }
 * @param {object} [opts] { clock, idFactory }
 */
function defineEvent(spec, opts = {}) {
  const version = Number.isInteger(spec.version) ? spec.version : 1;
  const contract = contractOf(spec.type, version);
  if (!contract) {
    throw new Error(`eventCatalog: unregistered contract "${spec.type} v${version}"`);
  }
  if (spec.producer && spec.producer !== contract.producer) {
    throw new Error(
      `eventCatalog: "${spec.type}" is produced by "${contract.producer}", not "${spec.producer}"`
    );
  }
  const payload = spec.payload || {};
  const missing = contract.required.filter((k) => payload[k] === undefined);
  if (missing.length) {
    throw new Error(
      `eventCatalog: "${spec.type} v${version}" missing payload keys: ${missing.join(', ')}`
    );
  }
  return createDomainEvent({ ...spec, version, producer: contract.producer }, opts);
}

/** defineFollowing — a catalog-validated event caused by a parent (trace chain). */
function defineFollowing(parent, spec, opts = {}) {
  const built = follows(parent, { ...spec, producer: spec.producer }, opts);
  // Re-validate through the catalog (built already has correlation/causation set).
  return defineEvent(
    {
      ...spec,
      correlationId: built.correlationId,
      causationId: built.causationId,
    },
    opts
  );
}

module.exports = { CATALOG, isRegistered, contractOf, listContracts, defineEvent, defineFollowing };
