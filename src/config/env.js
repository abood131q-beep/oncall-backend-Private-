'use strict';

/**
 * env.js — OnCall environment configuration loader
 * Loads .env from project root and validates required secrets.
 * Must be required BEFORE any module that uses JWT_SECRET or ADMIN_PHONES.
 */

const fs = require('fs');
const path = require('path');

// تحميل .env من جذر المشروع
const envPath = path.join(__dirname, '..', '..', '.env');
try {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .forEach((line) => {
        const [key, ...val] = line.split('=');
        if (key && val.length) {
          // Strip surrounding quotes (single or double) — standard .env behaviour
          process.env[key.trim()] = val
            .join('=')
            .trim()
            .replace(/^["'](.*)["']$/, '$1');
        }
      });
  }
} catch (_) {
  /* ignore */
}

if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is required in .env file');
  console.error('Run: echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env');
  process.exit(1);
}

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_PHONES: (process.env.ADMIN_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  PORT: parseInt(process.env.PORT, 10) || 3000,
  // إصلاح L6: تصدير NODE_ENV مع fallback صريح
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: (process.env.NODE_ENV || 'development') === 'production',
};
