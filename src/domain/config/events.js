'use strict';

/**
 * Configuration event catalog (Phase 14.3.2 §6) — PURE domain.
 *
 * Self-contained so the shared platform event catalog is not modified. Defines
 * the config lifecycle event types + versioned contracts, and a factory that
 * builds a canonical DomainEvent envelope (producer 'config'). Events are
 * published through the EventPublisher PORT only — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const CONFIG_EVENTS = Object.freeze({
  CHANGED: 'ConfigurationChanged',
  RELOADED: 'ConfigurationReloaded',
  VALIDATION_FAILED: 'ConfigurationValidationFailed',
  ROLLBACK: 'ConfigurationRollback',
  PROVIDER_CHANGED: 'ConfigurationProviderChanged',
});

const KNOWN = new Set(Object.values(CONFIG_EVENTS));
const isConfigEvent = (type) => KNOWN.has(type);

/**
 * Build a config DomainEvent.
 * @param {string} type one of CONFIG_EVENTS
 * @param {object} payload references + primitives (already redacted by caller)
 * @param {object} [opts] { clock, idFactory, correlationId, subject, version }
 */
function createConfigEvent(type, payload = {}, opts = {}) {
  if (!isConfigEvent(type)) throw new Error(`config events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'config',
      version: opts.version || 1,
      subject: opts.subject || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { CONFIG_EVENTS, isConfigEvent, createConfigEvent };
