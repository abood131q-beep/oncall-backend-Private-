'use strict';

/**
 * Provider registry (Phase 14.3.2 §2). Implemented adapters + declared extension
 * points for future distributed providers. Business logic never imports a
 * concrete provider; the composition root wires them via this registry.
 */

const { createEnvProvider } = require('./envProvider');
const { createJsonFileProvider } = require('./jsonFileProvider');
const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = {
  createEnvProvider,
  createJsonFileProvider,
  createMemoryProvider,
  // Extension points (declared, not implemented in this phase):
  FUTURE_PROVIDERS,
  futureProvider,
};
