'use strict';

/**
 * Environment Variables provider (Phase 14.3.2 §2) — feeds the `environment`
 * layer. Reads from an injected env source (defaults to a snapshot of
 * process.env) so it is deterministic and testable. Optionally filters by prefix
 * and maps `APP_DB_HOST` → `db.host` style keys.
 *
 * DI: pass `{ source, prefix, transformKey }`. No global reads beyond the
 * injected source; nothing here mutates process.env.
 */

function defaultTransform(key, prefix) {
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return stripped.toLowerCase().replace(/_/g, '.');
}

function createEnvProvider(opts = {}) {
  const source = opts.source || { ...process.env };
  const prefix = opts.prefix || '';
  const transformKey = opts.transformKey || ((k) => defaultTransform(k, prefix));
  const layer = opts.layer || 'environment';

  return {
    name: opts.name || 'env',
    layer,
    load() {
      const out = {};
      for (const [k, v] of Object.entries(source)) {
        if (prefix && !k.startsWith(prefix)) continue;
        out[transformKey(k)] = v;
      }
      return Promise.resolve(out);
    },
    get(key) {
      return this.load().then((bag) => bag[key]);
    },
  };
}

module.exports = { createEnvProvider };
