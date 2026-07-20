'use strict';

/**
 * Users routes — Presentation layer (Enterprise Architecture Migration Phase 3).
 *
 * Strangler cutover for the Users bounded context. The legacy
 * src/routes/users.js remains in the repository as the instant-rollback
 * implementation, selected via USERS_LEGACY=1 (see server.js).
 *
 * Paths, middleware (authenticate), auth requirements, status codes, JSON
 * shapes, key order, and Arabic messages are byte-identical to the legacy
 * router — proven by the live A/B harness (tests/integration/users-ab.mjs).
 *
 * SCOPE (exactly the legacy Users surface — no new endpoints, per Phase-3
 * "never introduce breaking changes / no new features"):
 *   POST /user/update · GET /balance/:phone · POST /balance/add (410) ·
 *   GET /transactions/:phone · GET /notifications/:phone ·
 *   PUT /notifications/:phone/read · POST /report
 */

const express = require('express');

const { createUsersApplication } = require('../../application/users');
const {
  createUserRepositoryAdapter,
} = require('../../infrastructure/repositories/userRepositoryAdapter');
const {
  createUserReadModelAdapter,
} = require('../../infrastructure/repositories/userReadModelAdapter');
const {
  createNotificationPreferenceAdapter,
} = require('../../infrastructure/notifications/notificationPreferenceAdapter');
const { createLocalizationService } = require('../../application/localization');
const { createUsersController } = require('./usersController');

/**
 * @param {object} svc — the existing DI container from server.js
 */
function createUsersRouter(svc) {
  const { logger, authenticate } = svc;

  const usersApp = createUsersApplication({
    userRepository: createUserRepositoryAdapter(svc),
    readModel: createUserReadModelAdapter(svc),
    notificationPreferences: createNotificationPreferenceAdapter(svc),
    auditLog: {
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
    },
  });

  // ADR-003 Globalization: inject the localization service (default locale 'ar'
  // → byte-identical responses; Accept-Language: en → localized). Injected so
  // the controller never imports the Domain directly (ADR-005 §4).
  const localization = createLocalizationService();
  const controller = createUsersController(usersApp, logger, localization);
  const router = express.Router();

  // Middleware (authenticate) and path order mirror the legacy router exactly.
  router.post('/user/update', authenticate, controller.updateProfile);
  router.get('/balance/:phone', authenticate, controller.getBalance);
  router.post('/balance/add', authenticate, controller.balanceAddDeprecated);
  router.get('/transactions/:phone', authenticate, controller.getActivity);
  router.get('/notifications/:phone', authenticate, controller.listNotifications);
  router.put('/notifications/:phone/read', authenticate, controller.markNotificationsRead);
  router.post('/report', authenticate, controller.submitReport);

  return router;
}

module.exports = { createUsersRouter };
