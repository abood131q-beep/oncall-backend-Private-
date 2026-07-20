'use strict';

/**
 * Storage provider registry (Phase 14.3.4 §4). Implemented adapters + declared
 * extension points for future durable providers. Business logic never imports a
 * concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { createFileProvider } = require('./fileProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = {
  createMemoryProvider,
  createFileProvider,
  FUTURE_PROVIDERS,
  futureProvider,
};
