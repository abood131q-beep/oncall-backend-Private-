'use strict';

/**
 * Rate-limit provider registry (Phase 15.2 / ADR-031 §4). Implemented adapters +
 * declared extension points for future policy/counter-store providers. Business
 * logic never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
