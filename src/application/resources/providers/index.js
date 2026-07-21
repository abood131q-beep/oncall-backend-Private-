'use strict';

/**
 * Resource provider registry (Phase 15.10 / ADR-039 §4). Implemented adapters +
 * declared extension points for future resource/allocation-store providers. Business
 * logic never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
