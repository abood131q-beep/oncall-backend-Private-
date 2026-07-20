'use strict';

/**
 * Identity provider registry (Phase 14.8 / ADR-027 §4). Implemented adapters +
 * declared extension points for future auth-protocol/persistence providers.
 * Business logic never imports a concrete provider; the composition root wires
 * them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
