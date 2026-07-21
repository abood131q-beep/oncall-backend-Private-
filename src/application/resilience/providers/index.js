'use strict';

/**
 * Resilience provider registry (Phase 15.7 / ADR-036 §4). Implemented adapters +
 * declared extension points for future policy/state-store providers. Business logic
 * never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
