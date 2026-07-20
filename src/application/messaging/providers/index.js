'use strict';

/**
 * Messaging provider registry (Phase 14.5 / ADR-024 §4). Implemented adapters +
 * declared extension points for future brokers. Business logic never imports a
 * concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
