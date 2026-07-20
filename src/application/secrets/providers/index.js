'use strict';

/**
 * Secrets provider registry (Phase 14.9 / ADR-028 §4). Implemented adapters +
 * declared extension points for future secret-store providers. Business logic
 * never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
