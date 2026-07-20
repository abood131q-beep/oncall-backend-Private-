'use strict';

/**
 * File storage provider (Phase 14.3.4 §4) — persists the whole store as one JSON
 * document via injected file I/O (testable without touching disk). Binary values
 * are base64-encoded on write and restored on read, so documents, key-value, and
 * binary objects all round-trip. `writeBatch` stages in memory then persists once
 * (atomic single-file write).
 *
 * DI: { path, readFile, writeFile }. readFile(path) → string | null (null if
 * absent); writeFile(path, text) → void. Defaults to fs sync (UTF-8).
 */

const fs = require('fs');

const BIN = '__binary_base64__';

function encode(value) {
  if ((typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) || value instanceof Uint8Array) {
    return { [BIN]: Buffer.from(value).toString('base64') };
  }
  return value;
}
function decode(value) {
  if (value && typeof value === 'object' && typeof value[BIN] === 'string') {
    return Buffer.from(value[BIN], 'base64');
  }
  return value;
}
function encRecord(r) {
  return { ...r, value: encode(r.value) };
}
function decRecord(r) {
  return r ? { ...r, value: decode(r.value), metadata: { ...r.metadata } } : r;
}

function createFileProvider(opts = {}) {
  if (!opts.path) throw new Error('fileProvider: path required');
  const path = opts.path;
  const readFile =
    opts.readFile ||
    ((p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
  const writeFile = opts.writeFile || ((p, text) => fs.writeFileSync(p, text));

  // In-memory mirror: namespace -> { key -> encodedRecord }. Loaded once.
  let store = null;
  function load() {
    if (store) return store;
    const text = readFile(path);
    store = text ? JSON.parse(text) : {};
    return store;
  }
  function persist() {
    writeFile(path, JSON.stringify(load()));
  }
  const bucket = (namespace) => {
    const s = load();
    if (!s[namespace]) s[namespace] = {};
    return s[namespace];
  };

  return {
    name: opts.name || `file:${path}`,
    read(namespace, key) {
      const b = load()[namespace];
      return Promise.resolve(b && b[key] ? decRecord(b[key]) : null);
    },
    write(namespace, key, record) {
      bucket(namespace)[key] = encRecord(record);
      persist();
      return Promise.resolve();
    },
    remove(namespace, key) {
      const b = load()[namespace];
      const existed = Boolean(b && b[key]);
      if (existed) {
        delete b[key];
        persist();
      }
      return Promise.resolve(existed);
    },
    has(namespace, key) {
      const b = load()[namespace];
      return Promise.resolve(Boolean(b && b[key]));
    },
    scan(namespace) {
      const b = load()[namespace];
      return Promise.resolve(b ? Object.values(b).map(decRecord) : []);
    },
    writeBatch(ops) {
      const s = load();
      // Stage on a deep copy so a bad op can't partially mutate the store.
      const staged = JSON.parse(JSON.stringify(s));
      for (const op of ops) {
        if (!staged[op.namespace]) staged[op.namespace] = {};
        if (op.op === 'put') staged[op.namespace][op.key] = encRecord(op.record);
        else if (op.op === 'del') delete staged[op.namespace][op.key];
        else return Promise.reject(new Error(`fileProvider: unknown batch op "${op.op}"`));
      }
      store = staged;
      persist();
      return Promise.resolve();
    },
    health() {
      const s = load();
      let records = 0;
      for (const b of Object.values(s)) records += Object.keys(b).length;
      return { ok: true, provider: 'file', path, namespaces: Object.keys(s).length, records };
    },
  };
}

module.exports = { createFileProvider };
