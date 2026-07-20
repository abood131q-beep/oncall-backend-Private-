'use strict';
const { assertPorts } = require('./ports');
const { createDriversUseCases, DriversError } = require('./useCases');
const commands = require('./commands');
function createDriversApplication(ports) {
  const verified = assertPorts(ports);
  return { useCases: createDriversUseCases(verified), commands, DriversError };
}
module.exports = { createDriversApplication, DriversError, commands };
