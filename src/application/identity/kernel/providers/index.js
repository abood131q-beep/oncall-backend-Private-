'use strict';

/**
 * providers/index.js — Consolidated Identity Kernel provider registry (Phase 19.4 skeleton, ADR-049).
 *
 * Registration surface for identity providers. SKELETON: registers only the inert default provider.
 */

const { createDefaultIdentityProvider } = require('./defaultProvider');

/** Build a provider registry. Deterministic; no I/O. */
function createProviderRegistry() {
  const registry = new Map();

  function register(provider) {
    if (!provider || typeof provider.name !== 'string') {
      throw new Error('identity provider registry: provider must have a name');
    }
    registry.set(provider.name, provider);
    return provider;
  }

  // Seed the default (inert) provider.
  register(createDefaultIdentityProvider());

  return Object.freeze({
    register,
    get: (name) => registry.get(name) || null,
    list: () => [...registry.keys()],
  });
}

module.exports = { createProviderRegistry, createDefaultIdentityProvider };
