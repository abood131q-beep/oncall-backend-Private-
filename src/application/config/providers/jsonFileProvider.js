'use strict';

/**
 * JSON File provider (Phase 14.3.2 §2) — feeds the `file` layer. Reads a JSON
 * document and flattens nested objects into dotted keys (`{db:{host}}` →
 * `db.host`). File I/O is injected (`readFile`) so the provider is testable
 * without touching disk, and supports reload by re-reading on load().
 *
 * DI: `{ path, readFile, layer }`. `readFile(path)` must return the file text
 * (sync or Promise). Defaults to fs.readFileSync (UTF-8).
 */

const fs = require('fs');

function flatten(obj, base, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = base ? `${base}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function createJsonFileProvider(opts = {}) {
  if (!opts.path) throw new Error('jsonFileProvider: path required');
  const path = opts.path;
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const layer = opts.layer || 'file';

  async function load() {
    let text;
    try {
      text = await readFile(path);
    } catch (err) {
      throw new Error(`jsonFileProvider: cannot read "${path}": ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`jsonFileProvider: invalid JSON in "${path}": ${err.message}`);
    }
    return flatten(parsed, '', {});
  }

  return {
    name: opts.name || `file:${path}`,
    layer,
    load,
    get(key) {
      return load().then((bag) => bag[key]);
    },
  };
}

module.exports = { createJsonFileProvider, flatten };
