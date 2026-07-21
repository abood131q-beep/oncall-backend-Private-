'use strict';

/**
 * Observability provider registry (Phase 15.4 / ADR-033 §4). Implemented adapters +
 * declared extension points for future telemetry store/export providers. Business
 * logic never imports a concrete provider; the composition root wires them here.
 */

const { createMemoryProvider } = require('./memoryProvider');
const { FUTURE_PROVIDERS, futureProvider } = require('../providerPort');

module.exports = { createMemoryProvider, FUTURE_PROVIDERS, futureProvider };
