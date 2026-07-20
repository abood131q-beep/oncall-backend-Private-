'use strict';

/**
 * Lock provider registry (Phase 14.3.5 §4). Implemented adapters + declared
 * extension points for future distributed lock backends. Business logic never
 * imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
