'use strict';

/**
 * Configuration Service (Phase 14.3.2 §1/§3/§5/§6/§7) — the Kernel Service and
 * SINGLE SOURCE OF TRUTH for runtime configuration. Everything obtains config
 * ONLY through this abstraction; no consumer touches a provider directly.
 *
 * Responsibilities:
 *   • Provider Abstraction — get/require/exists/list/watch/reload/validate/
 *     snapshot/version (§1).
 *   • Deterministic precedence resolution across layers (§3, domain/precedence).
 *   • Schema validation before activation (§4, domain/schema).
 *   • Runtime reload with automatic ROLLBACK on validation failure (§5).
 *   • Lifecycle events through the EventPublisher PORT only (§6).
 *   • Subscription model with old/new/timestamp/version/origin (§7).
 *   • Cache + metrics ports for observability (§8/§10).
 *   • Redaction of sensitive values on every observability surface (§9).
 *
 * Fully dependency-injected; no direct EventBus, no business logic, no globals.
 */

const precedence = require('../../domain/config/precedence');
const schema = require('../../domain/config/schema');
const redaction = require('../../domain/config/redaction');
const { createConfigEvent, CONFIG_EVENTS } = require('../../domain/config/events');
const { assertProvider } = require('./providerPort');
const { createNullPublisher } = require('../shared/eventPublisher');

function createConfigService(deps = {}) {
  const publisher = deps.publisher || createNullPublisher();
  const metrics = deps.metrics || null;
  const cache = deps.cache || null;
  const validationSchema = deps.schema || null;
  const clock = deps.clock || (() => new Date().toISOString());
  const log = deps.logger || { warn() {}, error() {}, info() {}, debug() {} };
  const redactionPatterns = deps.redactionPatterns || redaction.DEFAULT_PATTERNS;

  const providers = [];
  // Override bags for the non-provider precedence layers.
  const overrides = {
    runtime: { ...(deps.overrides && deps.overrides.runtime) },
    tenant: { ...(deps.overrides && deps.overrides.tenant) },
    organization: { ...(deps.overrides && deps.overrides.organization) },
    environment: { ...(deps.overrides && deps.overrides.environment) },
  };
  const defaults = { ...(deps.defaults || {}) };

  // Current activated snapshot: { values, origins, version, at }.
  let current = { values: {}, origins: {}, version: 0, at: clock() };
  // key -> Set(callback)
  const watchers = new Map();
  const providerUnsubs = [];

  for (const p of deps.providers || []) _registerProvider(p, { silent: true });

  function _registerProvider(p, { silent = false } = {}) {
    assertProvider(p);
    providers.push(p);
    if (typeof p.watch === 'function') {
      // Provider push → live reload (no restart).
      const un = p.watch(() => {
        reload({ origin: p.name }).catch((e) =>
          log.error('config: provider reload failed', e.message)
        );
      });
      if (typeof un === 'function') providerUnsubs.push(un);
    }
    if (!silent) {
      _publish(CONFIG_EVENTS.PROVIDER_CHANGED, { provider: p.name, layer: p.layer });
    }
    return p;
  }

  // ── layer assembly + resolution ──────────────────────────────────────────
  async function _composeLayers() {
    // Provider outputs merged into their declared layers (array order wins).
    const layerBags = { provider: {}, file: {}, environment: {} };
    for (const p of providers) {
      const bag = metrics ? await metrics.timeProvider(p.name, () => p.load()) : await p.load();
      const target = layerBags[p.layer] || (layerBags[p.layer] = {});
      Object.assign(target, bag);
    }
    return {
      runtime: overrides.runtime,
      tenant: overrides.tenant,
      organization: overrides.organization,
      environment: { ...layerBags.environment, ...overrides.environment },
      provider: layerBags.provider,
      file: layerBags.file,
      default: defaults,
    };
  }

  function _validate(resolvedValues) {
    if (!validationSchema) return { ok: true, value: {}, errors: [] };
    return schema.validate(resolvedValues, validationSchema);
  }

  /** Effective = resolved values with schema-normalized (default-applied) values on top. */
  function _effective(resolved, validated) {
    return { ...resolved, ...validated };
  }

  function _diff(oldValues, newValues) {
    const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
    const changed = [];
    for (const k of keys) {
      if (oldValues[k] !== newValues[k]) {
        changed.push({ key: k, oldValue: oldValues[k], newValue: newValues[k] });
      }
    }
    return changed;
  }

  // ── public: reload (build/rebuild the snapshot) ────────────────────────────
  async function reload({ origin = 'reload' } = {}) {
    const t0 = Date.now();
    const layers = await _composeLayers();
    const { values: resolved, origins } = precedence.resolve(layers);
    const { ok, value: validated, errors } = _validate(resolved);

    if (!ok) {
      if (metrics) metrics.recordValidationFailure();
      _publish(CONFIG_EVENTS.VALIDATION_FAILED, { errors, origin });
      log.warn('config: validation failed; keeping previous snapshot', { errors });
      if (current.version > 0) {
        // Automatic rollback: previous good snapshot stays active.
        _publish(CONFIG_EVENTS.ROLLBACK, { toVersion: current.version, errors });
        return { ok: false, rolledBack: true, errors, version: current.version };
      }
      // No previous good snapshot → cannot activate.
      const err = new Error(`config: initial configuration invalid: ${errors.join('; ')}`);
      err.errors = errors;
      throw err;
    }

    const effective = _effective(resolved, validated);
    const previous = current.values;
    const changed = _diff(previous, effective);

    if (metrics) metrics.recordReload(Date.now() - t0);

    // No effective change → keep the version stable (version tracks real changes).
    if (changed.length === 0) {
      current = { ...current, origins };
      if (cache) cache.set({ values: effective, origins, version: current.version });
      _publish(CONFIG_EVENTS.RELOADED, { version: current.version, changedKeys: [], origin });
      return { ok: true, version: current.version, changed: [] };
    }

    const version = current.version + 1;
    const at = clock();

    current = { values: effective, origins, version, at };
    if (cache) cache.set({ values: effective, origins, version });

    // Notify subscribers + publish events (redacted) for each changed key.
    for (const ch of changed) {
      _notifyWatchers(ch, origins[ch.key] || origin, version, at);
      _publish(CONFIG_EVENTS.CHANGED, {
        key: ch.key,
        oldValue: redaction.redactValue(ch.key, ch.oldValue, redactionPatterns),
        newValue: redaction.redactValue(ch.key, ch.newValue, redactionPatterns),
        origin: origins[ch.key] || origin,
        version,
      });
    }
    _publish(CONFIG_EVENTS.RELOADED, { version, changedKeys: changed.map((c) => c.key), origin });

    return { ok: true, version, changed: changed.map((c) => c.key) };
  }

  function _notifyWatchers(change, origin, version, at) {
    const set = watchers.get(change.key);
    if (!set || set.size === 0) return;
    const payload = {
      key: change.key,
      oldValue: change.oldValue,
      newValue: change.newValue,
      timestamp: at,
      version,
      origin,
    };
    for (const cb of set) {
      try {
        cb(payload);
        if (metrics) metrics.recordWatchNotification();
      } catch (e) {
        log.warn('config: watcher threw (isolated)', { key: change.key, err: e.message });
      }
    }
  }

  function _publish(type, payload) {
    try {
      const event = createConfigEvent(type, payload, { clock: () => new Date(current.at) });
      Promise.resolve(publisher.publish(event)).catch((e) =>
        log.error('config: event publish failed', e.message)
      );
    } catch (e) {
      log.error('config: could not build event', e.message);
    }
  }

  // ── public: provider abstraction (§1) ──────────────────────────────────────
  function get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(current.values, key)
      ? current.values[key]
      : fallback;
  }

  function require(key) {
    if (!exists(key)) throw new Error(`config: required key "${key}" is missing`);
    return current.values[key];
  }

  function exists(key) {
    return Object.prototype.hasOwnProperty.call(current.values, key);
  }

  function list(prefix) {
    return precedence.listKeys(current.values, prefix);
  }

  function watch(key, cb) {
    if (typeof cb !== 'function') throw new Error('config.watch: callback required');
    if (!watchers.has(key)) watchers.set(key, new Set());
    watchers.get(key).add(cb);
    if (metrics) metrics.setSubscriberCount(_subscriberCount());
    return function unsubscribe() {
      const set = watchers.get(key);
      if (set) {
        set.delete(cb);
        if (set.size === 0) watchers.delete(key);
      }
      if (metrics) metrics.setSubscriberCount(_subscriberCount());
    };
  }

  function _subscriberCount() {
    let n = 0;
    for (const set of watchers.values()) n += set.size;
    return n;
  }

  /** Validate the CURRENT resolved config (or a candidate) against the schema. */
  function validate(candidate) {
    if (candidate !== undefined) return _validate(candidate);
    return _validate(current.values);
  }

  /** Redacted, frozen view of the active configuration (safe for logs / UI). */
  function snapshot({ redact = true } = {}) {
    const values = redact
      ? redaction.redact(current.values, redactionPatterns)
      : { ...current.values };
    return Object.freeze({
      values: Object.freeze(values),
      origins: Object.freeze({ ...current.origins }),
      version: current.version,
      at: current.at,
    });
  }

  function version() {
    return current.version;
  }

  // ── override + provider management (runtime tier, §3) ──────────────────────
  function setOverride(scope, key, value) {
    if (!overrides[scope]) throw new Error(`config: unknown override scope "${scope}"`);
    overrides[scope][key] = value;
    return reload({ origin: `override:${scope}` });
  }
  function clearOverride(scope, key) {
    if (overrides[scope]) delete overrides[scope][key];
    return reload({ origin: `override:${scope}` });
  }
  function addProvider(p) {
    _registerProvider(p, { silent: false });
    return reload({ origin: `provider:${p.name}` });
  }

  function dispose() {
    for (const un of providerUnsubs) {
      try {
        un();
      } catch {
        /* ignore */
      }
    }
    watchers.clear();
  }

  return {
    // §1 provider abstraction
    get,
    require,
    exists,
    list,
    watch,
    reload,
    validate,
    snapshot,
    version,
    // management
    setOverride,
    clearOverride,
    addProvider,
    dispose,
    // introspection
    metrics: () => (metrics ? metrics.snapshot() : null),
  };
}

module.exports = { createConfigService };
