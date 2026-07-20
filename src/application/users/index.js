'use strict';

/**
 * Users application — composition entry point.
 * Verifies port implementations at startup (fail fast), then exposes the use
 * cases and command factories as the module's public surface.
 */

const { assertPorts } = require('./ports');
const { createUsersUseCases, UsersError } = require('./useCases');
const commands = require('./commands');

function createUsersApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createUsersUseCases(verified),
    commands,
    UsersError,
  };
}

module.exports = { createUsersApplication, UsersError, commands };
