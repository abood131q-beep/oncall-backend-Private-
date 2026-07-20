'use strict';

/**
 * Fleet application — composition entry point. Verifies port implementations at
 * startup (fail fast), then exposes use cases + command factories.
 */

const { assertPorts } = require('./ports');
const { createFleetUseCases, FleetError } = require('./useCases');
const commands = require('./commands');

function createFleetApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createFleetUseCases(verified),
    commands,
    FleetError,
  };
}

module.exports = { createFleetApplication, FleetError, commands };
