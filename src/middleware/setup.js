'use strict';

/**
 * setup.js — Express app middleware configuration
 *
 * يُهيّئ:
 *  - Helmet       : security headers
 *  - Compression  : gzip responses
 *  - Request ID   : X-Request-ID header
 *  - Metrics      : response time tracker
 *  - CORS         : localhost origins
 *  - JSON parser  : 1 MB limit
 *  - Sanitize     : body sanitization
 *  - Rate limit   : normal limit on all routes
 *  - Security hdrs: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection
 */

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

// P6-05B: CORS origins sourced from env.js (single source of truth).
// ALLOWED_ORIGINS = production domains (e.g. https://admin.oncall.app).
// Localhost regexes are always included for development compatibility.
// Phase 18.3: read via the runtime config facade (single approved config-read seam).
const config = require('../config');

const CORS_OPTIONS = {
  origin: [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    ...config.get('ALLOWED_ORIGINS'),
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token'],
  credentials: true,
  optionsSuccessStatus: 200,
};

/**
 * @param {import('express').Application} app
 * @param {{ sanitizeBody, normalLimit, metricsMiddleware, logger }} deps
 */
function setupMiddleware(app, { sanitizeBody, normalLimit, metricsMiddleware, logger }) {
  // ─── Optional packages ────────────────────────────────────────────────────
  // إصلاح M8: تفعيل CSP بسياسة مناسبة لـ API server (لا HTML — يتجاهله Flutter)
  try {
    app.use(
      require('helmet')({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'none'"],
            connectSrc: ["'self'"],
            // API server فقط — لا scripts ولا styles ولا frames
          },
        },
      })
    );
    logger.info('Helmet security headers enabled');
  } catch (_) {
    logger.warn('helmet not installed - run: npm install helmet');
  }

  try {
    app.use(require('compression')());
    logger.info('Response compression enabled');
  } catch (_) {
    logger.warn('compression not installed - run: npm install compression');
  }

  // ─── Core middleware ──────────────────────────────────────────────────────
  app.use((req, res, next) => {
    req.id = crypto.randomUUID(); // P6-03: proper UUID v4 for request tracing
    res.setHeader('X-Request-ID', req.id);
    next();
  });

  app.use(metricsMiddleware);
  app.use(cors(CORS_OPTIONS));
  app.options('/{*path}', cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(sanitizeBody);
  app.use(normalLimit);

  // ─── Security headers ─────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });
}

module.exports = { setupMiddleware };
