'use strict';

/**
 * Secrets Platform — composition entry point (Phase 14.9 / ADR-028). Wires the
 * service with a provider + metrics and returns the Kernel Service as one factory.
 * Purely additive: nothing here is on a hot path, so the platform runs
 * byte-identically whether or not the secrets kernel is instantiated.
 *
 *   const sk = createSecretsPlatform({ publisher });
 *   await sk.secrets.store({ name: 'db.password', value: 's3cr3t' });
 *   const { value } = await sk.secrets.resolve({ name: 'db.password' });
 *   await sk.secrets.rotate({ name: 'db.password', value: 'n3w' });
 */

const { createSecretsService } = require('./secretsService');
const { createSecretsMetrics } = require('./metrics');
const providers = require('./providers');
const secretsPort = require('./secretsPort');
const providerPort = require('./providerPort');
const { SECRET_EVENTS } = require('../../domain/secrets/events');

function createSecretsPlatform(deps = {}) {
  const metrics = deps.metrics || createSecretsMetrics({ clock: deps.clock });
  const provider = deps.provider || providers.createMemoryProvider();
  const secrets = createSecretsService({
    provider,
    publisher: deps.publisher,
    metrics,
    clock: deps.clock,
    logger: deps.logger,
    idFactory: deps.idFactory,
    valueFactory: deps.valueFactory,
    historyLimit: deps.historyLimit,
  });
  return { secrets, provider, metrics, SECRET_EVENTS };
}

module.exports = {
  createSecretsPlatform,
  createSecretsService,
  createSecretsMetrics,
  providers,
  secretsPort,
  providerPort,
  SECRET_EVENTS,
};
