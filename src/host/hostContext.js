'use strict';

/**
 * Host Context (Phase 16.3 / ADR-044 §7) — ONE immutable context describing the hosting
 * environment. It wraps the Bootstrap Runtime (ADR-043) and its composed Platform
 * (ADR-042) with the shared services hosted services may consume — without exposing any
 * kernel internals or any sibling service.
 *
 * Contents (per spec §7): runtime, platform, configuration, logger, metrics, environment,
 * version, shared services.
 *
 * "Each hosted service receives only the context it declares" — `scopeFor(needs)` returns
 * a frozen subset containing just the requested slices, so a service that declares only
 * `{ configuration, logger }` cannot reach the runtime, the platform, or anything else.
 */

const { HostStateError } = require('./errors');

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @param {object} parts
 * @param {object} parts.runtime  Bootstrap Runtime (ADR-043)
 * @param {object} [parts.logger]
 * @param {object} [parts.metrics]
 * @param {string} [parts.environment]
 * @param {string} [parts.version]
 * @param {object} [parts.configuration]
 * @param {object} [parts.sharedServices]
 */
function createHostContext(parts = {}) {
  const runtime = parts.runtime;
  if (!runtime || typeof runtime.platform !== 'function') {
    throw new HostStateError('hostContext: a Bootstrap Runtime (ADR-043) is required');
  }
  const platform = runtime.platform();
  const platformCtx = (platform && platform.context) || {};

  const context = {
    runtime,
    platform,
    configuration: parts.configuration || platformCtx.config || null,
    logger: parts.logger || platformCtx.logger || NOOP_LOGGER,
    metrics: parts.metrics || platformCtx.metrics || null,
    environment: parts.environment || platformCtx.environment || 'development',
    version: parts.version || (typeof runtime.version === 'function' ? runtime.version() : null),
    sharedServices: Object.freeze({ ...(parts.sharedServices || {}) }),
  };

  /** Return a frozen subset with ONLY the requested slices. */
  context.scopeFor = function scopeFor(needs = []) {
    const out = {};
    for (const key of needs) {
      if (!(key in context) || key === 'scopeFor') {
        throw new HostStateError(`hostContext: unknown context slice "${key}"`);
      }
      out[key] = context[key];
    }
    return Object.freeze(out);
  };

  return Object.freeze(context);
}

module.exports = { createHostContext };
