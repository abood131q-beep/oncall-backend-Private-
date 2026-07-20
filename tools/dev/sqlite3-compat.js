'use strict';

/**
 * sqlite3-compat — DEV/TEST preload shim (never used in production).
 *
 * Purpose: run the REAL backend in environments where the `sqlite3` native
 * binary is unavailable (e.g., Linux validation sandboxes with macOS-built
 * node_modules), by mapping the sqlite3 callback API onto node:sqlite.
 * Same approach as the P6-06 release-validation runs — project code untouched.
 *
 * Also: forces the process to honor process.env over the developer's .env
 * file (env.js otherwise overwrites env vars with .env contents), so test
 * runs are hermetic.
 *
 * Usage: node -r ./tools/dev/sqlite3-compat.js server.js
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ── Hermetic env: make env.js skip the developer .env file ───────────────────
const realExistsSync = fs.existsSync.bind(fs);
const projectEnv = path.join(__dirname, '..', '..', '.env');
fs.existsSync = (p) => (path.resolve(String(p)) === projectEnv ? false : realExistsSync(p));

// ── sqlite3 API compatibility layer over node:sqlite ─────────────────────────
function toPlain(row) {
  return row == null ? row : Object.assign({}, row);
}

class CompatDatabase {
  constructor(file) {
    this._db = new DatabaseSync(file);
  }

  serialize(fn) {
    if (typeof fn === 'function') fn();
  }

  configure() {
    /* no-op: busyTimeout etc. not applicable to node:sqlite sync driver */
  }

  exec(sql, cb) {
    try {
      this._db.exec(sql);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
    return this;
  }

  _normalize(params, cb) {
    if (typeof params === 'function') return { params: [], cb: params };
    return { params: params || [], cb };
  }

  run(sql, params, cb) {
    const n = this._normalize(params, cb);
    try {
      let info;
      try {
        info = this._db.prepare(sql).run(...n.params);
      } catch (e) {
        // Some statements (certain PRAGMAs) prefer exec; only safe with no params
        if (n.params.length === 0) {
          this._db.exec(sql);
          info = { changes: 0, lastInsertRowid: 0 };
        } else {
          throw e;
        }
      }
      if (n.cb) {
        n.cb.call({ lastID: Number(info.lastInsertRowid), changes: Number(info.changes) }, null);
      }
    } catch (err) {
      if (n.cb) n.cb.call({}, err);
      else if (process.env.SQLITE_COMPAT_DEBUG) console.error('[sqlite3-compat run]', err.message);
    }
    return this;
  }

  get(sql, params, cb) {
    const n = this._normalize(params, cb);
    try {
      const row = toPlain(this._db.prepare(sql).get(...n.params));
      if (n.cb) n.cb(null, row);
    } catch (err) {
      if (n.cb) n.cb(err);
    }
    return this;
  }

  all(sql, params, cb) {
    const n = this._normalize(params, cb);
    try {
      const rows = this._db
        .prepare(sql)
        .all(...n.params)
        .map(toPlain);
      if (n.cb) n.cb(null, rows);
    } catch (err) {
      if (n.cb) n.cb(err);
    }
    return this;
  }

  close(cb) {
    try {
      this._db.close();
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

const compat = { Database: CompatDatabase, verbose: () => compat };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'sqlite3') return compat;
  return realLoad.call(this, request, parent, isMain);
};
