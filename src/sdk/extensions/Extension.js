'use strict';

/**
 * Enterprise Extension SDK — `Extension` base class (Phase 14.3.1).
 *
 * The ONLY supported way to build an OnCall extension. A subclass declares its
 * identity, capabilities, and hooks with a framework-style API; the SDK turns
 * that into a registry-compatible package and eliminates all manual wiring:
 *
 *   class SurgePricing extends Extension {
 *     constructor() {
 *       super({ id: 'surge-pricing', name: 'Surge Pricing', version: '1.0.0',
 *               apiVersion: '1.0.0', author: 'OnCall Labs', description: '…',
 *               permissions: ['read:pricing'] });
 *       this.providesCapability('RidePricing');
 *       this.beforeRideRequest((ctx) => { … });
 *     }
 *     onEnable() { this.logger.info('enabled'); }
 *   }
 *   const pkg = new SurgePricing().toPackage();   // → registry.install(pkg)
 *
 * Guarantees this SDK preserves (never bypasses):
 *   • Ports only — capabilities/hooks reach the host solely through the sandbox
 *     context and the registry's `api.registerHook`. No EventBus/registry internals.
 *   • Deny-all — `publish`/`subscribe`/config read require a declared+granted
 *     permission or throw a typed PermissionError.
 *   • Additive — importing the SDK touches no hot path; a package it builds is the
 *     same `{ manifest, register(ctx, api) }` shape the Phase-14.2 registry expects.
 */

const { validateManifest } = require('../../domain/extensions/manifest');
const { isKnownCapability } = require('../../domain/extensions/capabilities');
const { HOOKS } = require('../../domain/extensions/hooksCatalog');
const { checksum } = require('../../domain/extensions/integrity');
const {
  ConfigurationError,
  CapabilityError,
  PermissionError,
  HookRegistrationError,
} = require('./errors');

const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  NOT_READY: 'not_ready',
});

/** BeforeRideRequest → beforeRideRequest (the hook-method name). */
function hookMethodName(hook) {
  return hook.charAt(0).toLowerCase() + hook.slice(1);
}

class Extension {
  /**
   * @param {object} spec manifest fields (capabilities & lifecycleHooks are
   *   derived from providesCapability()/hook registrations, so omit them here).
   * @param {object} [opts] { logger, clock, configProvider, correlationId }
   */
  constructor(spec = {}, opts = {}) {
    if (!spec || typeof spec !== 'object') {
      throw new ConfigurationError('Extension: a manifest spec object is required');
    }
    this._spec = { ...spec };
    this._capabilities = [];
    this._hooks = []; // { hook, fn }
    this._clock = opts.clock || (() => new Date().toISOString());
    this._baseLogger = opts.logger || defaultLogger();
    this._configProvider = opts.configProvider || null; // () => object
    this._config = Object.freeze({ ...(spec.configurationSchemaDefaults || {}) });
    this._correlationId = opts.correlationId || null;
    this._health = { status: HEALTH.NOT_READY, at: this._clock() };
    this._ctx = null; // sandbox context (set at register)
    this._api = null; // registry api (set at register)
    this._enabled = false;
    this._installed = false;

    // this.logger.{info,warn,error,debug} — auto-enriched.
    this.logger = buildLogger(this);

    // Freeze nothing user-facing yet; subclass constructor still runs.
  }

  // ── Identity ────────────────────────────────────────────────────────────
  get id() {
    return this._spec.id;
  }
  get version() {
    return this._spec.version;
  }

  // ── Capability API (declarative) ──────────────────────────────────────────
  /** Declare a capability this extension provides. Validated against the closed vocabulary. */
  providesCapability(name) {
    if (typeof name !== 'string' || !isKnownCapability(name)) {
      throw new CapabilityError(`unknown capability "${name}"`, { capability: name });
    }
    if (!this._capabilities.includes(name)) this._capabilities.push(name);
    return this;
  }

  // ── Hook API (clean registration; no registry internals) ──────────────────
  /** Internal: buffer a hook handler; flushed to the registry at register(). */
  _registerHook(hook, fn) {
    if (typeof fn !== 'function') {
      throw new HookRegistrationError(`hook "${hook}" handler must be a function`, { hook });
    }
    this._hooks.push({ hook, fn });
    return this;
  }

  // ── Configuration API ─────────────────────────────────────────────────────
  /** Current (frozen) configuration. */
  config() {
    return this._config;
  }

  /** Re-read config from the provider (or read:config port), validate, and notify. */
  async reloadConfig() {
    let next;
    if (typeof this._configProvider === 'function') {
      next = await this._configProvider();
    } else if (this._ctx && this._ctx['read:config'] && this._ctx['read:config'].get) {
      next = await this._ctx['read:config'].get();
    } else {
      throw new PermissionError('reloadConfig: no config provider and read:config not granted');
    }
    const validated = this.validateConfig(next);
    const previous = this._config;
    this._config = Object.freeze({ ...validated });
    if (typeof this.onConfigurationChanged === 'function') {
      await this.onConfigurationChanged(this._config, previous);
    }
    return this._config;
  }

  /**
   * Validate a config object against the manifest's configurationSchema.
   * Applies declared defaults, enforces declared types and required keys.
   * Throws ConfigurationError listing ALL problems. Returns the normalized config.
   */
  validateConfig(candidate = this._config) {
    const schema = this._spec.configurationSchema || {};
    const props = (schema && schema.properties) || {};
    const required = (schema && schema.required) || [];
    const out = {};
    const errors = [];

    for (const [key, def] of Object.entries(props)) {
      const has = candidate && Object.prototype.hasOwnProperty.call(candidate, key);
      const val = has ? candidate[key] : def && def.default;
      if (val === undefined && required.includes(key)) {
        errors.push(`missing required config "${key}"`);
        continue;
      }
      if (val !== undefined && def && def.type && actualType(val) !== def.type) {
        errors.push(`config "${key}" must be ${def.type}, got ${actualType(val)}`);
        continue;
      }
      if (val !== undefined) out[key] = val;
    }
    for (const key of required) {
      if (!(key in out) && !(props[key] && props[key].default !== undefined)) {
        if (!errors.some((e) => e.includes(`"${key}"`)))
          errors.push(`missing required config "${key}"`);
      }
    }
    if (errors.length) {
      throw new ConfigurationError(`invalid configuration: ${errors.join('; ')}`, { errors });
    }
    return out;
  }

  // ── Event API (ports only — no direct EventBus) ───────────────────────────
  /** Publish a DomainEvent through the granted publish:events port. */
  async publish(event) {
    const port = this._requirePort('publish:events', 'publish');
    return port.publish(event);
  }

  /** Subscribe to an event type through the granted subscribe:events port. */
  subscribe(type, handler) {
    const port = this._requirePort('subscribe:events', 'subscribe');
    if (typeof handler !== 'function') {
      throw new HookRegistrationError('subscribe: handler must be a function', { type });
    }
    return port.subscribe(type, handler);
  }

  _requirePort(perm, op) {
    if (!this._ctx) {
      throw new PermissionError(`${op}: extension not enabled yet (no sandbox context)`);
    }
    const port = this._ctx[perm];
    if (!port) {
      throw new PermissionError(`${op}: permission "${perm}" not granted`, { permission: perm });
    }
    return port;
  }

  // ── Health API ────────────────────────────────────────────────────────────
  healthy(detail) {
    return this._setHealth(HEALTH.HEALTHY, detail);
  }
  degraded(detail) {
    return this._setHealth(HEALTH.DEGRADED, detail);
  }
  failed(detail) {
    return this._setHealth(HEALTH.FAILED, detail);
  }
  notReady(detail) {
    return this._setHealth(HEALTH.NOT_READY, detail);
  }
  _setHealth(status, detail) {
    this._health = { status, detail, at: this._clock() };
    return this._health;
  }
  /** Current health snapshot. */
  health() {
    return this._health;
  }

  // ── Lifecycle drivers (call the optional onX hooks) ───────────────────────
  /**
   * Build the registry-compatible package. validateManifest runs here, so an
   * invalid extension is rejected before it can be installed.
   */
  toPackage() {
    const manifest = validateManifest(this._manifest());
    const bytes = JSON.stringify(manifest);
    const self = this;
    return {
      manifest,
      bytes,
      checksum: checksum(bytes),
      async register(ctx, api) {
        return self._register(ctx, api);
      },
    };
  }

  _manifest() {
    const s = this._spec;
    return {
      id: s.id,
      name: s.name,
      version: s.version,
      apiVersion: s.apiVersion,
      author: s.author,
      description: s.description,
      permissions: s.permissions || [],
      capabilities: [...this._capabilities],
      dependencies: s.dependencies || {},
      minimumPlatformVersion: s.minimumPlatformVersion || '1.0.0',
      compatibilityRules: s.compatibilityRules || {},
      lifecycleHooks: [...new Set(this._hooks.map((h) => h.hook))],
      configurationSchema: s.configurationSchema || {},
      healthChecks: s.healthChecks || [],
    };
  }

  /** Registry enable path: wire ctx, flush hooks, run onInstall/onEnable, return teardown. */
  async _register(ctx, api) {
    this._ctx = ctx || {};
    this._api = api;

    // Apply config defaults from the schema so config() is populated pre-reload.
    try {
      this._config = Object.freeze({ ...this.validateConfig(this._config) });
    } catch {
      /* defaults may be incomplete until reloadConfig; ignore here */
    }

    // Flush buffered hooks through the registry-provided api ONLY.
    for (const { hook, fn } of this._hooks) {
      api.registerHook(hook, (hookCtx) => fn.call(this, hookCtx));
    }

    if (!this._installed) {
      this._installed = true;
      if (typeof this.onInstall === 'function') await this.onInstall();
    }
    if (typeof this.onEnable === 'function') await this.onEnable();
    this._enabled = true;
    if (this._health.status === HEALTH.NOT_READY) this.healthy('enabled');

    const self = this;
    return async function teardown() {
      await self._disable();
    };
  }

  async _disable() {
    if (!this._enabled) return;
    this._enabled = false;
    if (typeof this.onDisable === 'function') await this.onDisable();
    this.notReady('disabled');
    this._ctx = null;
    this._api = null;
  }

  /** Explicit unload (host calls registry.unload) → onUnload. */
  async unload() {
    await this._disable();
    if (typeof this.onUnload === 'function') await this.onUnload();
  }

  /** Run the extension's health check (onHealthCheck override or stored health). */
  async runHealthCheck() {
    if (typeof this.onHealthCheck === 'function') {
      const r = await this.onHealthCheck();
      if (r && r.status) this._health = { ...r, at: this._clock() };
    }
    return this._health;
  }

  /** Correlation id used by the logger; propagate a request/trace id here. */
  withCorrelation(correlationId) {
    this._correlationId = correlationId;
    return this;
  }
}

// Generate a clean, named method for every catalog hook: this.beforeRideRequest(fn), …
for (const hook of HOOKS) {
  const method = hookMethodName(hook);
  Extension.prototype[method] = function (fn) {
    return this._registerHook(hook, fn);
  };
}

function actualType(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function defaultLogger() {
  /* eslint-disable no-console */
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: (...a) => console.debug(...a),
  };
  /* eslint-enable no-console */
}

/** Wrap a base logger so every line carries extension id/version/correlationId/timestamp. */
function buildLogger(ext) {
  const emit = (level) => (message, meta) => {
    const base = ext._baseLogger || {};
    const fn = typeof base[level] === 'function' ? base[level] : base.info;
    const record = {
      extensionId: ext._spec.id,
      version: ext._spec.version,
      correlationId: ext._correlationId || null,
      timestamp: ext._clock(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
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

module.exports = { Extension, HEALTH };
