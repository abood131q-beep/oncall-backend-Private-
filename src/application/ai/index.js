'use strict';

/**
 * AI / Automation application — composition entry point. Verifies port
 * implementations at startup (fail fast), then exposes use cases + command
 * factories. Composing this context is side-effect-free: it builds pure objects
 * and a disabled provider; it mounts no HTTP route and calls no provider.
 */

const { assertPorts } = require('./ports');
const { createAIUseCases, AIError } = require('./useCases');
const commands = require('./commands');

function createAIApplication(ports) {
  const verified = assertPorts(ports);
  return {
    useCases: createAIUseCases(verified),
    commands,
    AIError,
  };
}

module.exports = { createAIApplication, AIError, commands };
