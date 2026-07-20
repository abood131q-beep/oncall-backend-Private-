'use strict';

/**
 * Commerce application — composition entry point. Verifies port implementations
 * at startup (fail fast), then exposes use cases + command factories.
 */

const { assertPorts } = require('./ports');
const { createCommerceUseCases, CommerceError } = require('./useCases');
const commands = require('./commands');

function createCommerceApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createCommerceUseCases(verified),
    commands,
    CommerceError,
  };
}

module.exports = { createCommerceApplication, CommerceError, commands };
