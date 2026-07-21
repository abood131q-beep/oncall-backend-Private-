'use strict';

/**
 * Platform Context (Phase 16.1 / ADR-042 §2) — ONE immutable, shared context created
 * once by the builder and handed (in scoped, need-only slices) to every Kernel via
 * dependency injection. Kernels never reach for globals; everything they may consume
 * lives here and is frozen so no kernel can mutate what another kernel sees.
 *
 * Contents (per spec §2): clock, logger, metrics, configuration, event publisher,
 * mutex, version, environment, health provider, shared services.
 *
 * "Every Kernel receives ONLY what it needs" — `scopeFor(needs)` returns a frozen
 * subset containing just the declared slices, so a kernel that needs only
 * `{ publisher, clock }` cannot accidentally couple to anything else.
 */

const { PlatformValidationError } = require('./errors');

/** A deterministic per-key async mutex (promise-chaining; no wall-clock timers). */
function createMutex() {
  const chains = new Map();
  return {
    runExclusive(key, fn) {
      const prev = chains.get(key) || Promise.resolve();
      const next = prev.then(fn, fn);
      chains.set(
        key,
        next.then(
          () => {},
          () => {}
        )
      );
      return next;
    },
    pending() {
      return chains.size;
    },
  };
}

/** A minimal in-process platform metrics registry (deterministic; injectable clock). */
function createPlatformMetrics(clock) {
  const now = clock || (() => Date.now());
  const startedAt = now();
  const counters = new Map();
  return {
    inc(name, by = 1) {
      counters.set(name, (counters.get(name) || 0) + by);
    },
    get(name) {
      return counters.get(name) || 0;
    },
    snapshot() {
      return { uptimeMs: now() - startedAt, counters: Object.fromEntries(counters) };
    },
  };
}

/** A read-only accessor over injected configuration values. */
function createConfigView(values) {
  const frozen = Object.freeze({ ...(values || {}) });
  return Object.freeze({
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(frozen, key) ? frozen[key] : fallback;
    },
    has(key) {
      return Object.prototype.hasOwnProperty.call(frozen, key);
    },
    all() {
      return frozen;
    },
  });
}

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @param {object} [options]
 * @param {Function} [options.clock] () => epoch ms
 * @param {object}   [options.logger] { info, warn, error, debug }
 * @param {object}   [options.metrics] platform metrics registry
 * @param {object}   [options.config] raw configuration values
 * @param {object}   [options.publisher] EventPublisher (the Event Backbone, ADR-016)
 * @param {object}   [options.mutex] shared async mutex
 * @param {string}   [options.version] platform version
 * @param {string}   [options.environment] 'development' | 'staging' | 'production'
 * @param {object}   [options.healthProvider] optional external health contributor
 * @param {object}   [options.sharedServices] additional injected services
 */
function createPlatformContext(options = {}) {
  const clock = options.clock || (() => Date.now());
  if (typeof clock !== 'function') {
    throw new PlatformValidationError('platformContext: clock must be a function');
  }
  const publisher = options.publisher;
  if (!publisher || typeof publisher.publish !== 'function') {
    throw new PlatformValidationError(
      'platformContext: an EventPublisher (Event Backbone) with publish() is required'
    );
  }

  const context = {
    clock,
    logger: options.logger || NOOP_LOGGER,
    metrics: options.metrics || createPlatformMetrics(clock),
    config:
      options.config && typeof options.config.get === 'function'
        ? options.config
        : createConfigView(options.config),
    publisher,
    mutex: options.mutex || createMutex(),
    version: options.version || '16.1.0',
    environment: options.environment || process.env.NODE_ENV || 'development',
    healthProvider: options.healthProvider || null,
    sharedServices: Object.freeze({ ...(options.sharedServices || {}) }),
  };

  /** Return a frozen subset with ONLY the requested slices. */
  context.scopeFor = function scopeFor(needs = []) {
    const out = {};
    for (const key of needs) {
      if (!(key in context)) {
        throw new PlatformValidationError(`platformContext: unknown context slice "${key}"`);
      }
      out[key] = context[key];
    }
    return Object.freeze(out);
  };

  return Object.freeze(context);
}

module.exports = {
  createPlatformContext,
  createMutex,
  createPlatformMetrics,
  createConfigView,
};
