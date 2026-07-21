'use strict';

/**
 * Multi-tenancy provider registry (Phase 15.9 / ADR-038 §4). Implemented adapters +
 * declared extension points for future tenant-store providers. Business logic never
 * imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
