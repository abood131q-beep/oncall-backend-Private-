'use strict';

/**
 * Admin application — composition entry point. Verifies port implementations at
 * startup (fail fast), then exposes use cases + command factories.
 */

const { assertPorts } = require('./ports');
const { createAdminUseCases, AdminError } = require('./useCases');
const commands = require('./commands');

function createAdminApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createAdminUseCases(verified),
    commands,
    AdminError,
  };
}

module.exports = { createAdminApplication, AdminError, commands };
