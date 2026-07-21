'use strict';

/**
 * identityRepository.js — Consolidated Identity Kernel infrastructure (Phase 19.4 skeleton, ADR-049 §5).
 *
 * Future owner of the identity persistence seam (reads Users/Drivers via their repos; owns the
 * login_logs write). Implements the kernel's `identityRepositoryPort`. SKELETON: inert
 * (`IdentityKernelNotWired`); the existing `infrastructure/repositories/identityRepositoryAdapter.js`
 * remains authoritative for the production path.
 */

const { IdentityKernelNotWired } = require('../../domain/identity/kernel/errors');

function createIdentityRepository(deps = {}) {
  // Pass-through to the injected legacy repo functions; inert (NotWired) when a fn is absent.
  const pt = (fn, m) =>
    typeof fn === 'function'
      ? fn
      : () => {
          throw new IdentityKernelNotWired(`identityRepository.${m}`);
        };
  return Object.freeze({
    findUserByPhone: pt(deps.findUserByPhone, 'findUserByPhone'),
    createUser: pt(deps.createUser, 'createUser'),
    findDriverByPhone: pt(deps.findDriverByPhone, 'findDriverByPhone'),
    createDriver: pt(deps.createDriver, 'createDriver'),
    setDriverPresence: pt(deps.setDriverPresence, 'setDriverPresence'),
    recordLoginLog: pt(deps.recordLoginLog, 'recordLoginLog'),
  });
}

module.exports = { createIdentityRepository };
