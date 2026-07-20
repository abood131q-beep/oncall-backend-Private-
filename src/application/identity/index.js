'use strict';

/**
 * Identity application — composition entry point.
 * Verifies port implementations at startup (fail fast), then exposes the
 * use cases and command factories as the module's public surface.
 */

const { assertPorts } = require('./ports');
const { createIdentityUseCases, AuthRejection } = require('./useCases');
const commands = require('./commands');

function createIdentityApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createIdentityUseCases(verified),
    commands,
    AuthRejection,
  };
}

module.exports = { createIdentityApplication, AuthRejection, commands };
