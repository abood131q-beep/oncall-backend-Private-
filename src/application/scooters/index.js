'use strict';

/**
 * Scooters application — composition entry point. Verifies port
 * implementations at startup (fail fast), then exposes the use cases and
 * command factories as the module's public surface.
 */

const { assertPorts } = require('./ports');
const { createScootersUseCases, ScootersError } = require('./useCases');
const commands = require('./commands');

function createScootersApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createScootersUseCases(verified),
    commands,
    ScootersError,
  };
}

module.exports = { createScootersApplication, ScootersError, commands };
