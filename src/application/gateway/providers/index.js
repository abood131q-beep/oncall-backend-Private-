'use strict';

/**
 * API-gateway provider registry (Phase 15.6 / ADR-035 §4). Implemented adapters +
 * declared extension points for future route-store providers. Business logic never
 * imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
