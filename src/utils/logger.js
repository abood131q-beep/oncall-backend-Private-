'use strict';

/**
 * logger.js — OnCall centralized logger
 *
 * يكتب سجلات مُوقَّتة إلى logs/server.log والـ console.
 * يُنظِّف ملف السجل تلقائياً عند تجاوز 10 MB.
 * يحتفظ بآخر 200 سجل في الذاكرة لـ GET /admin/logs.
 */

const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', '..', 'logs');
const logFile = path.join(logDir, 'server.log');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// تنظيف logs القديمة (أكبر من 10MB)
try {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10 * 1024 * 1024) {
    fs.writeFileSync(logFile, '');
    console.log('ℹ️  Log file cleared (>10MB)');
  }
} catch (_) {
  /* ignore */
}

/** Ring buffer — آخر 200 سجل في الذاكرة */
const _logBuffer = [];
const _LOG_BUFFER_SIZE = 200;

const logger = {
  /**
   * يكتب السجل إلى الملف والـ buffer الداخلي.
   * @param {string} level
   * @param {string} msg
   * @param {*} [data]
   * @returns {string} السطر المُنسَّق بدون \n
   */
  _write(level, msg, data) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    const line = `[${timestamp}] [${level}] ${msg}${dataStr}\n`;
    logStream.write(line);

    // ring buffer
    _logBuffer.push({ timestamp, level, msg, data: data || null });
    if (_logBuffer.length > _LOG_BUFFER_SIZE) _logBuffer.shift();

    return line.trim();
  },

  info(msg, data) {
    const l = this._write('INFO', msg, data);
    console.log(`ℹ️  ${l}`);
  },
  warn(msg, data) {
    const l = this._write('WARN', msg, data);
    console.warn(`⚠️  ${l}`);
  },
  error(msg, data) {
    const l = this._write('ERROR', msg, data);
    console.error(`❌ ${l}`);
    // إصلاح M7: طباعة stack trace إذا كان موجوداً لتسهيل التشخيص
    if (data && data.stack && typeof data.stack === 'string') {
      console.error(data.stack);
    }
  },
  success(msg, data) {
    const l = this._write('OK', msg, data);
    console.log(`✅ ${l}`);
  },

  /**
   * يُعيد آخر n سجل من الـ ring buffer.
   * @param {number} [n=50]   عدد السجلات المطلوبة
   * @param {string} [level]  فلترة حسب المستوى (INFO | WARN | ERROR | OK)
   * @returns {{ timestamp: string, level: string, msg: string, data: * }[]}
   */
  getLogs(n = 50, level = null) {
    const limit = Math.min(Math.max(1, Number(n) || 50), _LOG_BUFFER_SIZE);
    const filtered = level ? _logBuffer.filter((e) => e.level === level.toUpperCase()) : _logBuffer;
    return filtered.slice(-limit);
  },

  /**
   * يمسح جميع السجلات من الـ ring buffer في الذاكرة وملف السجل.
   * @returns {{ cleared: number }} عدد السجلات التي تم مسحها
   */
  clearLogs() {
    const cleared = _logBuffer.length;
    _logBuffer.length = 0;
    try {
      fs.writeFileSync(logFile, '');
    } catch (_) {
      /* ignore */
    }
    return { cleared };
  },
};

module.exports = logger;
