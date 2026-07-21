'use strict';

/**
 * Notification provider registry (Phase 15.1 / ADR-030 §4). Implemented adapters +
 * declared extension points for future delivery providers. Business logic never
 * imports a concrete provider; the composition root / registerChannel wires them.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
