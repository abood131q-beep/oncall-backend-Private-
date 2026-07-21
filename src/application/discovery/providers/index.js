'use strict';

/**
 * Service-discovery provider registry (Phase 15.5 / ADR-034 §4). Implemented
 * adapters + declared extension points for future registry providers. Business
 * logic never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
