'use strict';

/**
 * Identity routes — Presentation layer (STRANGLER: NOT YET MOUNTED).
 *
 * Phase 2 (cutover): this router carries all Identity traffic. The legacy
 * src/routes/auth.js remains in the repository as the instant-rollback
 * implementation, selected via IDENTITY_LEGACY=1 (see server.js).
 *
 * Paths, middleware order (rate limits), auth requirements, status codes,
 * JSON shapes, and messages are byte-identical to the legacy router —
 * proven by the live A/B harness (tests/integration/identity-ab.mjs).
 */

const express = require('express');

const { createIdentityApplication } = require('../../application/identity');
const {
  createIdentityRepositoryAdapter,
} = require('../../infrastructure/repositories/identityRepositoryAdapter');
const { createTokenGatewayAdapter } = require('../../infrastructure/gateways/tokenGatewayAdapter');
const { createOtpGatewayAdapter } = require('../../infrastructure/gateways/otpGatewayAdapter');
const { createIdentityController } = require('./identityController');

/**
 * @param {object} svc — the existing DI container from server.js
 * @param {object} env — { REQUIRE_OTP, SMS_PROVIDER } from src/config/env
 */
function createIdentityRouter(svc, env) {
  const { logger, loginLimit, phoneLoginLimit, authenticate, ADMIN_PHONES } = svc;

  const identityApp = createIdentityApplication({
    identityRepository: createIdentityRepositoryAdapter(svc),
    tokenGateway: createTokenGatewayAdapter(svc),
    otpGateway: createOtpGatewayAdapter({
      dbGet: svc.dbGet,
      dbRun: svc.dbRun,
      logger,
      requireOtp: env.REQUIRE_OTP,
      smsProvider: env.SMS_PROVIDER,
    }),
    auditLog: {
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      security: (kind, details) => logger.security(kind, details),
    },
    adminPhones: ADMIN_PHONES,
  });
  identityApp.otpRequired = Boolean(env.REQUIRE_OTP);

  const controller = createIdentityController(identityApp, logger);
  const router = express.Router();

  router.post('/auth/otp/send', loginLimit, phoneLoginLimit, controller.sendOtp);
  router.post('/login', loginLimit, phoneLoginLimit, controller.loginPassenger);
  router.post('/driver/login', loginLimit, phoneLoginLimit, controller.loginDriver);
  router.post('/auth/refresh', loginLimit, controller.refreshSession);
  router.post('/logout', controller.logout);
  router.post('/auth/logout-all', authenticate, controller.logoutAll);
  router.get('/auth/verify', controller.verifySession);
  router.get('/auth/is-admin', controller.isAdmin);

  return router;
}

module.exports = { createIdentityRouter };
