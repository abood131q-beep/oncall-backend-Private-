'use strict';

/**
 * sessionStore.js — Consolidated Identity Kernel infrastructure (Phase 19.4 skeleton, ADR-049 §5).
 *
 * Future owner of session + device-identity persistence. Implements the kernel's `sessionStorePort`.
 * SKELETON: inert (`IdentityKernelNotWired`). No session storage is introduced this phase.
 */

const { IdentityKernelNotWired } = require('../../domain/identity/kernel/errors');

function createIdentitySessionStore(/* deps */) {
  return Object.freeze({
    persist: () => {
      throw new IdentityKernelNotWired('sessionStore.persist');
    },
    find: () => {
      throw new IdentityKernelNotWired('sessionStore.find');
    },
    revoke: () => {
      throw new IdentityKernelNotWired('sessionStore.revoke');
    },
  });
}

module.exports = { createIdentitySessionStore };
