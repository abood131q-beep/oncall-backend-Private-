'use strict';

/**
 * defaultProvider.js — Consolidated Identity Kernel provider (Phase 19.4 skeleton, ADR-049).
 *
 * A provider supplies persistence/protocol for the kernel (same pattern as the Config kernel's
 * providers). SKELETON: the default provider declares its identity but performs no work — its
 * operations throw `IdentityKernelNotWired`. Real providers (env/DB-backed) arrive with the
 * consolidation phase.
 */

const { IdentityKernelNotWired } = require('../../../../domain/identity/kernel/errors');

function createDefaultIdentityProvider() {
  return Object.freeze({
    name: 'default',
    layer: 'identity',
    load: () => {
      throw new IdentityKernelNotWired('provider.default.load');
    },
  });
}

module.exports = { createDefaultIdentityProvider };
