'use strict';

/**
 * Trips application — composition entry point. Verifies port implementations at
 * startup (fail fast), then exposes use cases + command factories.
 */

const { assertPorts } = require('./ports');
const { createTripsUseCases, TripsError } = require('./useCases');
const commands = require('./commands');

function createTripsApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createTripsUseCases(verified),
    commands,
    TripsError,
  };
}

module.exports = { createTripsApplication, TripsError, commands };
