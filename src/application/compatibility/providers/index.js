'use strict';

/**
 * Compatibility provider registry (Phase 15.12 / ADR-041 §4). Implemented adapters +
 * declared extension points for future contract-metadata providers. Business logic
 * never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
