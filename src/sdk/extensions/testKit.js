'use strict';

/**
 * Extension SDK — Testing Kit (Phase 14.3.1).
 *
 * Lets developers unit-test an extension WITHOUT booting the platform, while
 * still exercising the real hook-execution semantics (isolation, timeout, and
 * Before* veto) via the actual hookBus. Provides mock Context, mock Ports, mock
 * Events, and mock Configuration, plus a `harness()` that drives an Extension
 * instance through its full lifecycle and lets tests fire hooks and assert.
 *
 *   const { harness, createMockEvents } = require('.../sdk/extensions/testKit');
 *   const events = createMockEvents();
 *   const h = await harness(new SurgePricing(), {
 *     ports: { 'read:pricing': { currentMultiplier: () => 3 }, 'publish:events': events },
 *   });
 *   const res = await h.runHook('BeforeRideRequest', { demandIndex: 2, cityRef: 'NYC' });
 *   assert.equal(res.cancelled, true);
 */

const { createHookBus } = require('../../application/extensions/hookBus');

/** A recording logger — captures every enriched log line for assertions. */
function createMockLogger() {
  const lines = [];
  const push = (level) => (record) => lines.push({ level, record });
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    clear: () => (lines.length = 0),
  };
}

/**
 * Mock event publisher/subscriber port. Records published events and dispatches
 * to subscribers so tests can simulate an inbound event through ports only.
 */
function createMockEvents() {
  const published = [];
  const subscribers = new Map(); // type -> Set(handler)
  return {
    published,
    publish(event) {
      published.push(event);
      return Promise.resolve();
    },
    subscribe(type, handler) {
      if (!subscribers.has(type)) subscribers.set(type, new Set());
      subscribers.get(type).add(handler);
      return () => subscribers.get(type).delete(handler);
    },
    /** Test helper: deliver an event to its subscribers. */
    async emit(type, event) {
      const set = subscribers.get(type) || new Set();
      for (const h of set) await h(event);
      return set.size;
    },
  };
}

/** Mock configuration provider — returns a fixed object, mutable between reloads. */
function createMockConfig(initial = {}) {
  let current = { ...initial };
  const provider = () => ({ ...current });
  provider.set = (next) => {
    current = { ...next };
  };
  provider.patch = (partial) => {
    current = { ...current, ...partial };
  };
  return provider;
}

/**
 * Build a mock sandbox context from a plain map of ports keyed by permission.
 * Frozen, mirroring the real deny-all sandbox surface (only listed ports exist).
 */
function createMockContext(ports = {}) {
  return Object.freeze({ ...ports });
}

/**
 * Default mock ports covering the common permissions, so most extensions can be
 * tested with zero setup. Override any entry via the `ports` option.
 */
function createMockPorts(overrides = {}) {
  return {
    'read:pricing': { currentMultiplier: () => 1, getRules: () => ({}) },
    'read:config': { get: async () => ({}) },
    'publish:events': createMockEvents(),
    'subscribe:events': createMockEvents(),
    ...overrides,
  };
}

/**
 * Drive an Extension instance without the platform.
 *
 * @param {Extension} extension an instantiated SDK Extension
 * @param {object} [opts]
 *   ports: { [permission]: portObject }  — becomes the sandbox context
 *   config: object|function              — initial config or a provider
 *   logger: mock logger                  — defaults to a recording logger
 *   timeoutMs/breakerThreshold/clock     — forwarded to the real hookBus
 * @returns {Promise<object>} driver with runHook/disable/unload/health/etc.
 */
async function harness(extension, opts = {}) {
  const logger = opts.logger || createMockLogger();
  const ports = opts.ports || createMockPorts();
  const ctx = createMockContext(ports);

  // Inject the mock logger + config provider into the instance.
  extension._baseLogger = logger;
  extension.logger = rebuildLogger(extension);
  if (opts.config) {
    extension._configProvider = typeof opts.config === 'function' ? opts.config : () => opts.config;
  }

  // Real hookBus → real isolation/timeout/veto semantics, no platform needed.
  const bus = createHookBus({
    logger: opts.logger || { warn() {}, error() {} },
    timeoutMs: opts.timeoutMs,
    breakerThreshold: opts.breakerThreshold,
    breakerCooldownMs: opts.breakerCooldownMs,
    clock: opts.clock,
  });

  const extId = extension.id;
  const api = {
    registerHook: (hook, fn) => bus.register(hook, fn, { extId }),
    manifest: extension._manifest(),
  };

  const pkg = extension.toPackage(); // validates the manifest
  const teardown = await pkg.register(ctx, api);

  return {
    extension,
    manifest: pkg.manifest,
    logger,
    ports,
    /** Fire a hook exactly as the platform would; returns { cancelled, reason, results }. */
    runHook: (hook, hookCtx) => bus.run(hook, hookCtx),
    /** Was the extension's circuit breaker opened for this hook? */
    breakerOpen: () => bus.breakerOpen(extId),
    reloadConfig: () => extension.reloadConfig(),
    runHealthCheck: () => extension.runHealthCheck(),
    health: () => extension.health(),
    disable: () => teardown(),
    unload: () => extension.unload(),
  };
}

function rebuildLogger(ext) {
  const emit = (level) => (message, meta) => {
    const record = {
      extensionId: ext._spec.id,
      version: ext._spec.version,
      correlationId: ext._correlationId || null,
      timestamp: ext._clock(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
    const base = ext._baseLogger || {};
    const fn = typeof base[level] === 'function' ? base[level] : base.info;
    if (typeof fn === 'function') fn(record);
    return record;
  };
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
  };
}

module.exports = {
  harness,
  createMockLogger,
  createMockEvents,
  createMockConfig,
  createMockContext,
  createMockPorts,
};
