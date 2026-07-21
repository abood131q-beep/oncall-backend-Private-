'use strict';

/**
 * Compatibility Kernel — composition entry point (Phase 15.12 / ADR-041). Wires the
 * service with a provider + metrics and returns the Kernel Service as one factory.
 * Purely additive: nothing here is on a hot path, so the platform runs byte-identically
 * whether or not the compatibility kernel is instantiated.
 *
 *   const ck = createCompatibilityPlatform({ publisher });
 *   await ck.compatibility.registerContract({
 *     component: 'billing-api', version: '2.1.0',
 *     supportedVersions: ['1.0.0', '2.0.0', '2.1.0'],
 *     capabilities: ['invoices', 'refunds'], compatibilityLevel: 'backward',
 *   });
 *   await ck.compatibility.evaluate({ contractId, version: '2.0.0', capabilities: ['invoices'] });
 *   await ck.compatibility.negotiate({ contractId, version: '>=2.0.0', capabilities: ['refunds'] });
 */

const { createCompatibilityService } = require('./compatibilityService');
const { createCompatibilityMetrics } = require('./metrics');
const providers = require('./providers');
const compatibilityPort = require('./compatibilityPort');
const providerPort = require('./providerPort');
const { toCompatibilityPort } = require('./sdkAdapter');
const { COMPATIBILITY_EVENTS } = require('../../domain/compatibility/events');

function createCompatibilityPlatform(deps = {}) {
  const metrics = deps.metrics || createCompatibilityMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const compatibility = createCompatibilityService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    historyLimit: deps.historyLimit,
  });
  return { compatibility, provider, metrics, COMPATIBILITY_EVENTS };
}

module.exports = {
  createCompatibilityPlatform,
  createCompatibilityService,
  createCompatibilityMetrics,
  providers,
  compatibilityPort,
  providerPort,
  toCompatibilityPort,
  COMPATIBILITY_EVENTS,
};
