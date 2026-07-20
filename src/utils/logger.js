'use strict';

/**
 * logger.js — OnCall Structured Logger (P6-03)
 *
 * Features:
 *  - Levels: DEBUG, INFO, WARN, ERROR, FATAL, OK (success), SECURITY
 *  - 3 rotating log files (daily rotation, 30-day retention):
 *      logs/app.log      — all levels
 *      logs/error.log    — WARN, ERROR, FATAL only
 *      logs/security.log — SECURITY events only
 *  - Ring buffers in memory:
 *      main     (1000 entries) — for GET /admin/logs
 *      errors   (200 entries)  — WARN+
 *      security (200 entries)  — SECURITY events
 *      crashes  (50 entries)   — FATAL + uncaughtException
 *  - Backward-compatible API: info/warn/error/success/getLogs/clearLogs
 *  - New API: debug/fatal/security/getSecurityEvents/getCrashes/getErrors
 */

const fs = require('fs');
const path = require('path');

// ─── Log level filtering ──────────────────────────────────────────────────────
// env.js validates LOG_LEVEL and normalises it in process.env at startup.
// Logger reads process.env.LOG_LEVEL at call time (not at module load) so it
// works correctly even when logger.js is loaded before env.js in test contexts.
// logger.js intentionally does NOT import env.js to remain a zero-dependency
// utility (avoids circular-dependency risk in isolated test scenarios).
const _LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function _isLevelEnabled(level) {
  const configured = _LOG_LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? 1;
  return (_LOG_LEVELS[level] ?? 0) >= configured;
}

// ─── Log directory ────────────────────────────────────────────────────────────

const logDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// ─── Rotating file stream ────────────────────────────────────────────────────

class RotatingFileStream {
  constructor(filename) {
    this._dir = logDir;
    this._filename = filename;
    this._date = null; // current YYYY-MM-DD
    this._stream = null;
    this._open();
  }

  /** Returns today's YYYY-MM-DD string */
  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Open (or rotate to) today's log file */
  _open() {
    const today = this._today();
    if (today === this._date && this._stream) return; // already open for today

    // Close existing stream
    if (this._stream) {
      try {
        this._stream.end();
      } catch (_) {}
      this._stream = null;
    }

    // Archive the previous day's file
    if (this._date && this._date !== today) {
      const current = path.join(this._dir, this._filename);
      const archive = path.join(this._dir, `${this._filename}.${this._date}`);
      try {
        if (fs.existsSync(current)) fs.renameSync(current, archive);
      } catch (_) {}

      // Cleanup files older than 30 days (async-ish via setImmediate)
      setImmediate(() => this._cleanup());
    }

    this._date = today;

    try {
      this._stream = fs.createWriteStream(path.join(this._dir, this._filename), { flags: 'a' });
    } catch (_) {
      this._stream = null;
    }
  }

  /** Write a JSON line to the rotating file */
  write(jsonLine) {
    this._open(); // rotates automatically on date change
    if (!this._stream) return;
    try {
      this._stream.write(jsonLine + '\n');
    } catch (_) {}
  }

  /** Delete archived files older than 30 days */
  _cleanup() {
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const re = new RegExp(`^${this._filename}\\.(\\d{4}-\\d{2}-\\d{2})$`);
      for (const f of fs.readdirSync(this._dir)) {
        const m = f.match(re);
        if (!m) continue;
        try {
          if (new Date(m[1]).getTime() < cutoff) {
            fs.unlinkSync(path.join(this._dir, f));
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

// ─── Log file instances ───────────────────────────────────────────────────────

const _appLog = new RotatingFileStream('app.log');
const _errorLog = new RotatingFileStream('error.log');
const _securityLog = new RotatingFileStream('security.log');

// ─── Ring buffers ─────────────────────────────────────────────────────────────

const _logBuffer = []; // all levels — for /admin/logs
const _errorBuffer = []; // WARN+ — for /admin/errors
const _securityBuffer = []; // SECURITY events — for /admin/security-events
const _crashBuffer = []; // FATAL + uncaughtException — for /admin/crashes

const _BUF_SIZE_MAIN = 1000;
const _BUF_SIZE_ERROR = 200;
const _BUF_SIZE_SECURITY = 200;
const _BUF_SIZE_CRASH = 50;

/** Push to a ring buffer, capping at max size */
function _pushBuf(buf, entry, max) {
  buf.push(entry);
  if (buf.length > max) buf.shift();
}

// ─── Core write function ──────────────────────────────────────────────────────

/**
 * Write a log entry to buffers and files.
 * @param {string} level
 * @param {string} msg
 * @param {*} [data]
 * @param {{ isError?: boolean, isSecurity?: boolean, isCrash?: boolean }} [opts]
 * @returns {string} formatted line (for console output)
 */
function _write(level, msg, data, opts = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  const line = `[${timestamp}] [${level}] ${msg}${dataStr}`;

  // 1. Main ring buffer (backward compat: keeps {timestamp, level, msg, data} format)
  const entry = { timestamp, level, msg, data: data || null };
  _pushBuf(_logBuffer, entry, _BUF_SIZE_MAIN);

  // 2. JSON line for rotating log files
  const jsonLine = JSON.stringify(
    data !== undefined && data !== null
      ? { timestamp, level, msg, data }
      : { timestamp, level, msg }
  );

  // Write to app.log (all levels)
  _appLog.write(jsonLine);

  // Write to error.log (WARN, ERROR, FATAL)
  if (opts.isError) {
    _errorLog.write(jsonLine);
    _pushBuf(_errorBuffer, entry, _BUF_SIZE_ERROR);
  }

  // Write to security.log (SECURITY events only)
  if (opts.isSecurity) {
    _securityLog.write(jsonLine);
    _pushBuf(_securityBuffer, entry, _BUF_SIZE_SECURITY);
  }

  // Crash buffer (FATAL)
  if (opts.isCrash) {
    _pushBuf(_crashBuffer, entry, _BUF_SIZE_CRASH);
  }

  return line;
}

// ─── Logger API ───────────────────────────────────────────────────────────────

const logger = {
  // ── Standard levels ──────────────────────────────────────────────────────

  /** DEBUG — verbose; only emitted when LOG_LEVEL=DEBUG */
  debug(msg, data) {
    if (!_isLevelEnabled('DEBUG')) return;
    const l = _write('DEBUG', msg, data);
    console.debug(`🔍 ${l}`);
  },

  /** INFO — general operational messages; suppressed when LOG_LEVEL=WARN or ERROR */
  info(msg, data) {
    if (!_isLevelEnabled('INFO')) return;
    const l = _write('INFO', msg, data);
    console.log(`ℹ️  ${l}`);
  },

  /** WARN — recoverable issues (goes to error.log too); suppressed when LOG_LEVEL=ERROR */
  warn(msg, data) {
    if (!_isLevelEnabled('WARN')) return;
    const l = _write('WARN', msg, data, { isError: true });
    console.warn(`⚠️  ${l}`);
  },

  /** ERROR — non-fatal errors (goes to error.log too); always emitted */
  error(msg, data) {
    const l = _write('ERROR', msg, data, { isError: true });
    console.error(`❌ ${l}`);
    if (data && data.stack && typeof data.stack === 'string') {
      console.error(data.stack);
    }
  },

  /** FATAL — unrecoverable error (goes to error.log + crash buffer); always emitted */
  fatal(msg, data) {
    const l = _write('FATAL', msg, data, { isError: true, isCrash: true });
    console.error(`💀 ${l}`);
    if (data && data.stack && typeof data.stack === 'string') {
      console.error(data.stack);
    }
  },

  /** OK / success — successful operations (alias: success) */
  success(msg, data) {
    const l = _write('OK', msg, data);
    console.log(`✅ ${l}`);
  },

  // ── Security level ────────────────────────────────────────────────────────

  /**
   * SECURITY — security events: auth failures, rate limits, IDOR attempts, etc.
   * Writes to security.log AND the main app.log.
   */
  security(event, ctx) {
    const l = _write('SECURITY', event, ctx, { isSecurity: true });
    console.warn(`🔐 ${l}`);
  },

  // ── Ring buffer accessors ─────────────────────────────────────────────────

  /**
   * Returns the last n log entries from the main buffer.
   * Used by GET /admin/logs (backward compat).
   * @param {number} [n=50]
   * @param {string|null} [level]
   */
  getLogs(n = 50, level = null) {
    const limit = Math.min(Math.max(1, Number(n) || 100), _BUF_SIZE_MAIN);
    const filtered = level ? _logBuffer.filter((e) => e.level === level.toUpperCase()) : _logBuffer;
    return filtered.slice(-limit);
  },

  /**
   * Returns the last n entries from the error buffer (WARN+).
   * Used by GET /admin/errors.
   */
  getErrors(n = 100) {
    const limit = Math.min(Math.max(1, Number(n) || 100), _BUF_SIZE_ERROR);
    return _errorBuffer.slice(-limit);
  },

  /**
   * Returns the last n entries from the security buffer.
   * Used by GET /admin/security-events.
   */
  getSecurityEvents(n = 50) {
    const limit = Math.min(Math.max(1, Number(n) || 50), _BUF_SIZE_SECURITY);
    return _securityBuffer.slice(-limit);
  },

  /**
   * Returns the last n entries from the crash buffer.
   * Used by GET /admin/crashes.
   */
  getCrashes(n = 20) {
    const limit = Math.min(Math.max(1, Number(n) || 20), _BUF_SIZE_CRASH);
    return _crashBuffer.slice(-limit);
  },

  /**
   * Clears main ring buffer and truncates app.log.
   * Used by POST /admin/logs/clear (backward compat).
   */
  clearLogs() {
    const cleared = _logBuffer.length;
    _logBuffer.length = 0;
    try {
      fs.writeFileSync(path.join(logDir, 'app.log'), '');
    } catch (_) {}
    return { cleared };
  },
};

module.exports = logger;
