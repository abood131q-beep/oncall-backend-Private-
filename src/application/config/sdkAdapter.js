'use strict';

/**
 * SDK ↔ Configuration Platform adapter (Phase 14.3.2 §11).
 *
 * Bridges the Extension SDK (ADR-018) to the Configuration Platform WITHOUT
 * modifying the SDK and WITHOUT exposing provider internals. The SDK's
 * `this.config()`, `this.reloadConfig()`, and `this.validateConfig()` already
 * read from either an injected config provider function or a granted
 * `read:config` port; this adapter produces both shapes from the config service.
 *
 * Keys are optionally scoped by `prefix` (e.g. `ext.surge-pricing.`) and the
 * prefix is stripped so they match the extension's own configurationSchema.
 */

function _scoped(service, prefix) {
  const snap = service.snapshot({ redact: false });
  if (!prefix) return { ...snap.values };
  const out = {};
  for (const [k, v] of Object.entries(snap.values)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** A `read:config` PORT: `{ get() }` — wire into an extension's portFactories. */
function toReadConfigPort(service, { prefix = '' } = {}) {
  return {
    get: () => Promise.resolve(_scoped(service, prefix)),
  };
}

/** A `configProvider` function `() => object` — matches the SDK's opts.configProvider. */
function toConfigProvider(service, { prefix = '' } = {}) {
  return () => _scoped(service, prefix);
}

/**
 * Bind an SDK Extension instance to the platform so `reloadConfig()` pulls from
 * it, and re-run reload when a watched prefix key changes. Returns an unbind fn.
 */
function bindExtensionConfig(extension, service, { prefix = '' } = {}) {
  extension._configProvider = toConfigProvider(service, { prefix });
  return () => {
    extension._configProvider = null;
  };
}

module.exports = { toReadConfigPort, toConfigProvider, bindExtensionConfig };
