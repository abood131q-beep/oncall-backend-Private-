'use strict';

/**
 * Extension Registry (Phase 14.2 §2/§7/§8/§10) — the orchestrator.
 *
 * Lifecycle: register → enable ⇄ disable → (upgrade/rollback) → uninstall.
 * Hot-pluggable: install/enable/disable/reload/unload/upgrade/rollback all run
 * without a server restart (in-process registration). Security gates
 * (checksum + signature + compatibility + manifest validation) run at install.
 * Isolation is delegated to the hookBus (timeout + circuit breaker). Every
 * transition is observable via the metrics port.
 *
 * An "extension package" given to install():
 *   { manifest, bytes?, checksum?, signature?, register(ctx, api) }
 * where register() wires the extension's capabilities/hooks using ONLY the
 * sandbox context (deny-all by default).
 */

const { validateManifest } = require('../../domain/extensions/manifest');
const integrity = require('../../domain/extensions/integrity');
const { createSandbox } = require('./sandbox');

const STATES = Object.freeze({
  REGISTERED: 'registered',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  UNINSTALLED: 'uninstalled',
});

function createExtensionRegistry(deps = {}) {
  const hookBus = deps.hookBus;
  const metrics = deps.metrics;
  const portFactories = deps.portFactories || {}; // permission -> () => port
  const env = deps.env || {}; // { platformVersion, platformApiRange }
  const verifier = deps.signatureVerifier || null;
  const requireSignature = Boolean(deps.requireSignature);
  const now = deps.clock || (() => Date.now());
  const log = deps.logger || { warn() {}, error() {}, info() {} };
  if (!hookBus) throw new Error('registry: hookBus required');

  // id -> record { manifest, state, sandbox, teardown, versions[], pkg }
  const installed = new Map();

  function _securityGate(pkg) {
    const manifest = validateManifest(pkg.manifest); // throws ManifestError on invalid
    if (pkg.bytes !== undefined || pkg.checksum !== undefined) {
      const c = integrity.verifyChecksum(pkg.bytes ?? '', pkg.checksum);
      if (!c.ok) throw new Error(`integrity: ${c.reason}`);
    }
    const s = integrity.verifySignature(pkg.bytes ?? manifest.id, pkg.signature, verifier, {
      required: requireSignature,
    });
    if (!s.ok) throw new Error(`integrity: ${s.reason}`);
    const compat = integrity.verifyCompatibility(manifest, env);
    if (!compat.ok) throw new Error(`compatibility: ${compat.problems.join('; ')}`);
    return manifest;
  }

  /** install → validate + security gate + register (does not enable). */
  async function install(pkg) {
    const start = now();
    const manifest = _securityGate(pkg);
    if (installed.has(manifest.id) && installed.get(manifest.id).state !== STATES.UNINSTALLED) {
      throw new Error(`extension "${manifest.id}" already installed`);
    }
    const record = {
      manifest,
      state: STATES.REGISTERED,
      sandbox: null,
      teardown: null,
      pkg,
      versions: installed.get(manifest.id)?.versions || [],
    };
    installed.set(manifest.id, record);
    if (metrics) {
      metrics.setLoadTime(manifest.id, now() - start);
      metrics.setHealth(manifest.id, 'registered');
    }
    log.info && log.info('extension installed', { id: manifest.id, version: manifest.version });
    return { id: manifest.id, state: record.state };
  }

  /** enable → build sandbox and run the extension's register() to wire hooks. */
  async function enable(id) {
    const rec = _get(id);
    if (rec.state === STATES.ENABLED) return { id, state: STATES.ENABLED };
    const sandbox = createSandbox(rec.manifest, portFactories, { logger: log });
    const api = {
      registerHook: (hook, fn) => hookBus.register(hook, fn, { extId: id }),
      manifest: rec.manifest,
    };
    const teardown = (await rec.pkg.register(sandbox.context, api)) || (() => {});
    rec.sandbox = sandbox;
    rec.teardown = typeof teardown === 'function' ? teardown : () => {};
    rec.state = STATES.ENABLED;
    if (metrics) metrics.setHealth(id, 'healthy');
    log.info && log.info('extension enabled', { id });
    return { id, state: STATES.ENABLED, granted: sandbox.granted };
  }

  /** disable → remove hooks + run teardown; keep it installed (hot, reversible). */
  async function disable(id) {
    const rec = _get(id);
    if (rec.state !== STATES.ENABLED) return { id, state: rec.state };
    await _deactivate(rec, id);
    rec.state = STATES.DISABLED;
    if (metrics) metrics.setHealth(id, 'disabled');
    log.info && log.info('extension disabled', { id });
    return { id, state: STATES.DISABLED };
  }

  async function _deactivate(rec, id) {
    hookBus.removeExtension(id);
    try {
      if (rec.teardown) await rec.teardown();
    } catch (err) {
      log.warn && log.warn('extension teardown threw (ignored)', { id, err: err.message });
    }
    rec.teardown = null;
    rec.sandbox = null;
  }

  /** uninstall → deactivate + drop record (retains version history for reinstall). */
  async function uninstall(id) {
    const rec = _get(id);
    if (rec.state === STATES.ENABLED) await _deactivate(rec, id);
    rec.state = STATES.UNINSTALLED;
    if (metrics) metrics.remove(id);
    log.info && log.info('extension uninstalled', { id });
    return { id, state: STATES.UNINSTALLED };
  }

  /** reload → disable then enable (hot; picks up a re-registered handler set). */
  async function reload(id) {
    await disable(id);
    return enable(id);
  }

  /** unload → alias for disable (kept installed, hooks removed). */
  const unload = disable;

  /**
   * upgrade → install a new version package, preserving the prior for rollback.
   * The prior enabled state is restored on the new version.
   */
  async function upgrade(id, newPkg) {
    const rec = _get(id);
    const wasEnabled = rec.state === STATES.ENABLED;
    const prior = { pkg: rec.pkg, manifest: rec.manifest };
    if (wasEnabled) await _deactivate(rec, id);

    const newManifest = _securityGate(newPkg);
    if (newManifest.id !== id) throw new Error(`upgrade id mismatch: ${newManifest.id} != ${id}`);

    rec.versions = [...rec.versions, prior]; // history for rollback
    rec.manifest = newManifest;
    rec.pkg = newPkg;
    rec.state = STATES.REGISTERED;
    if (metrics) metrics.setHealth(id, 'registered');
    if (wasEnabled) await enable(id);
    log.info && log.info('extension upgraded', { id, version: newManifest.version });
    return { id, version: newManifest.version, state: rec.state };
  }

  /** rollback → restore the most recent prior version and re-enable if it was on. */
  async function rollback(id) {
    const rec = _get(id);
    if (!rec.versions.length)
      throw new Error(`extension "${id}" has no prior version to roll back to`);
    const wasEnabled = rec.state === STATES.ENABLED;
    if (wasEnabled) await _deactivate(rec, id);
    const prior = rec.versions.pop();
    rec.manifest = prior.manifest;
    rec.pkg = prior.pkg;
    rec.state = STATES.REGISTERED;
    if (wasEnabled) await enable(id);
    log.info && log.info('extension rolled back', { id, version: rec.manifest.version });
    return { id, version: rec.manifest.version, state: rec.state };
  }

  // ── Discovery ────────────────────────────────────────────────────────────
  function get(id) {
    const rec = installed.get(id);
    return rec ? { id, state: rec.state, manifest: rec.manifest } : null;
  }
  function list() {
    return [...installed.values()]
      .filter((r) => r.state !== STATES.UNINSTALLED)
      .map((r) => ({
        id: r.manifest.id,
        version: r.manifest.version,
        state: r.state,
        capabilities: r.manifest.capabilities,
      }));
  }
  function findByCapability(cap) {
    return list().filter((x) => x.capabilities.includes(cap));
  }

  function _get(id) {
    const rec = installed.get(id);
    if (!rec || rec.state === STATES.UNINSTALLED)
      throw new Error(`extension "${id}" not installed`);
    return rec;
  }

  return {
    STATES,
    install,
    enable,
    disable,
    uninstall,
    reload,
    unload,
    upgrade,
    rollback,
    get,
    list,
    findByCapability,
  };
}

module.exports = { createExtensionRegistry, STATES };
