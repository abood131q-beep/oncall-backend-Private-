'use strict';

/**
 * index.js — Consolidated Identity Kernel infrastructure barrel (Phase 19.4 skeleton, ADR-049).
 *
 * Assembles the inert port adapters into the shape the kernel's `assertPorts` expects. This is a
 * composition helper used by a composition root (NOT by the application layer — ADR-005 forbids
 * application→infrastructure imports). SKELETON: every adapter is inert (`IdentityKernelNotWired`).
 */

const { createIdentityTokenAdapter } = require('./tokenAdapter');
const { createIdentityOtpAdapter } = require('./otpAdapter');
const { createIdentityRepository } = require('./identityRepository');
const { createIdentitySessionStore } = require('./sessionStore');

/**
 * Build the identity infrastructure port set (skeleton, all inert).
 * @param {object} [deps] the DI container (unused in the skeleton; consumed at consolidation).
 * @returns port set compatible with application/identity/kernel `assertPorts`.
 */
function createIdentityInfrastructure(deps = {}) {
  return {
    tokenPort: createIdentityTokenAdapter(deps),
    otpPort: createIdentityOtpAdapter(deps),
    identityRepositoryPort: createIdentityRepository(deps),
    sessionStorePort: createIdentitySessionStore(deps),
  };
}

module.exports = {
  createIdentityInfrastructure,
  createIdentityTokenAdapter,
  createIdentityOtpAdapter,
  createIdentityRepository,
  createIdentitySessionStore,
};
