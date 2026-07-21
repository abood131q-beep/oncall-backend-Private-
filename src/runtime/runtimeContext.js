'use strict';

/**
 * Runtime Context (Phase 16.2 / ADR-043 §3) — ONE immutable context describing a single
 * bootstrapped runtime instance. It wraps the composed Platform (ADR-042) with the
 * operational metadata a production supervisor needs, without re-implementing anything the
 * platform already owns.
 *
 * Contents (per spec §3): platform, configuration, environment, startup timestamp,
 * version, supervisor, shutdown manager, health snapshot, bootstrap metadata.
 *
 * The context object is frozen. The mutable operational surfaces (supervisor state, latest
 * health snapshot) live behind their own objects; the context holds stable references to
 * them so the frozen wrapper never needs to change.
 */

const { RuntimeStateError } = require('./errors');

/**
 * @param {object} parts
 * @param {object} parts.platform      composed Platform (ADR-042)
 * @param {object} parts.configuration frozen configuration view / values
 * @param {string} parts.environment
 * @param {number} parts.startedAt     epoch ms of bootstrap start
 * @param {string} parts.version
 * @param {object} parts.supervisor    RuntimeSupervisor
 * @param {object} parts.shutdownManager ShutdownManager
 * @param {object} parts.bootstrapMetadata { verification, startupDurationMs, ... }
 * @param {Function} [parts.clock]
 */
function createRuntimeContext(parts = {}) {
  const required = ['platform', 'supervisor', 'shutdownManager'];
  for (const key of required) {
    if (!parts[key]) throw new RuntimeStateError(`runtimeContext: "${key}" is required`);
  }
  const clock = parts.clock || (() => Date.now());

  // Latest health snapshot lives in a small mutable holder the supervisor updates; the
  // frozen context exposes read-only access to it.
  const healthHolder = { snapshot: parts.healthSnapshot || null };

  const context = {
    platform: parts.platform,
    configuration:
      parts.configuration || (parts.platform.context && parts.platform.context.config) || null,
    environment:
      parts.environment ||
      (parts.platform.context && parts.platform.context.environment) ||
      'development',
    startedAt: parts.startedAt != null ? parts.startedAt : clock(),
    version: parts.version || parts.platform.version(),
    supervisor: parts.supervisor,
    shutdownManager: parts.shutdownManager,
    bootstrapMetadata: Object.freeze({ ...(parts.bootstrapMetadata || {}) }),

    /** The most recent health snapshot recorded by the supervisor (or null). */
    healthSnapshot() {
      return healthHolder.snapshot;
    },
    /** Internal: supervisor records the latest snapshot here. */
    _recordHealth(snapshot) {
      healthHolder.snapshot = snapshot;
      return snapshot;
    },
    /** Uptime since bootstrap start. */
    uptimeMs() {
      return clock() - context.startedAt;
    },
  };

  return Object.freeze(context);
}

module.exports = { createRuntimeContext };
