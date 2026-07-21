'use strict';

/**
 * Lifecycle provider registry (Phase 15.11 / ADR-040 §4). Implemented adapters +
 * declared extension points for future lifecycle-metadata providers. Business logic
 * never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
