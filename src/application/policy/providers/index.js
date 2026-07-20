'use strict';

/**
 * Policy provider registry (Phase 14.6 / ADR-025 §4). Implemented adapters +
 * declared extension points for future policy definition stores. Business logic
 * never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
