'use strict';

/**
 * Notifications application — composition entry point. Verifies port
 * implementations at startup (fail fast), then exposes use cases + commands.
 */

const { assertPorts } = require('./ports');
const { createNotificationsUseCases, NotificationsError } = require('./useCases');
const commands = require('./commands');

function createNotificationsApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createNotificationsUseCases(verified),
    commands,
    NotificationsError,
  };
}

module.exports = { createNotificationsApplication, NotificationsError, commands };
