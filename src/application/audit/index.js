'use strict';

/**
 * Audit Platform — composition entry point (Phase 14.7 / ADR-026). Wires the
 * service with an append-only provider + metrics and returns the Kernel Service
 * as one factory. Purely additive: nothing here is on a hot path, so the
 * platform runs byte-identically whether or not audit is instantiated.
 *
 *   const audit = createAuditPlatform({ publisher });
 *   const rec = await audit.audit.record({ action: 'trip.created', actor: 'u1' });
 *   const timeline = await audit.audit.query({ filter: { correlationId: 'c1' } });
 *   const integrity = await audit.audit.verify();
 */

const { createAuditService } = require('./auditService');
const { createAuditMetrics } = require('./metrics');
const providers = require('./providers');
const auditPort = require('./auditPort');
const providerPort = require('./providerPort');
const { AUDIT_EVENTS } = require('../../domain/audit/events');

function createAuditPlatform(deps = {}) {
  const metrics = deps.metrics || createAuditMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const audit = createAuditService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
  });
  return { audit, provider, metrics, AUDIT_EVENTS };
}

module.exports = {
  createAuditPlatform,
  createAuditService,
  createAuditMetrics,
  providers,
  auditPort,
  providerPort,
  AUDIT_EVENTS,
};
