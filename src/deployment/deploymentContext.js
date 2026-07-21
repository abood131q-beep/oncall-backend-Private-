'use strict';

/**
 * Deployment Context (Phase 16.4 / ADR-045 §7) — ONE immutable context describing the
 * deployment environment. It wraps the Host Runtime (ADR-044), its Bootstrap Runtime
 * (ADR-043), and the composed Platform (ADR-042) with the dependencies deployment
 * components may consume — without exposing kernel internals.
 *
 * Contents (per spec §7): host, runtime, platform, configuration, logger, metrics,
 * environment, version, deployment metadata.
 *
 * "Each deployment component receives only the dependencies it declares" —
 * `scopeFor(needs)` returns a frozen subset with just the requested slices.
 */

const { DeploymentStateError } = require('./errors');

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @param {object} parts
 * @param {object} parts.host    Host Runtime (ADR-044)
 * @param {object} [parts.logger]
 * @param {object} [parts.metrics]
 * @param {string} [parts.environment]
 * @param {string} [parts.version]
 * @param {object} [parts.configuration]
 * @param {object} [parts.deploymentMetadata]
 */
function createDeploymentContext(parts = {}) {
  const host = parts.host;
  if (!host || typeof host.runtime !== 'function' || typeof host.register !== 'function') {
    throw new DeploymentStateError('deploymentContext: a Host Runtime (ADR-044) is required');
  }
  const runtime = host.runtime();
  const platform = typeof runtime.platform === 'function' ? runtime.platform() : null;
  const hostCtx = (typeof host.context === 'function' && host.context()) || {};
  const platformCtx = (platform && platform.context) || {};

  const context = {
    host,
    runtime,
    platform,
    configuration: parts.configuration || hostCtx.configuration || platformCtx.config || null,
    logger: parts.logger || hostCtx.logger || platformCtx.logger || NOOP_LOGGER,
    metrics: parts.metrics || hostCtx.metrics || platformCtx.metrics || null,
    environment:
      parts.environment || hostCtx.environment || platformCtx.environment || 'development',
    version: parts.version || (typeof runtime.version === 'function' ? runtime.version() : null),
    deploymentMetadata: Object.freeze({ ...(parts.deploymentMetadata || {}) }),
  };

  /** Return a frozen subset with ONLY the requested slices. */
  context.scopeFor = function scopeFor(needs = []) {
    const out = {};
    for (const key of needs) {
      if (!(key in context) || key === 'scopeFor') {
        throw new DeploymentStateError(`deploymentContext: unknown context slice "${key}"`);
      }
      out[key] = context[key];
    }
    return Object.freeze(out);
  };

  return Object.freeze(context);
}

module.exports = { createDeploymentContext };
