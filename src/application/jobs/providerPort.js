'use strict';

/**
 * JobsProvider PORT (Phase 15.3 / ADR-032 §4) — persistence ONLY. Providers store
 * JOB models; they never execute handlers, retry, time out, dead-letter, or emit
 * events — all execution logic lives in the engine, so engine behavior is identical
 * regardless of provider. NOT BullMQ/RabbitMQ/Sidekiq/Hangfire — Redis/PostgreSQL/
 * Storage/MongoDB/message queues are declared extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putJob(namespace, model) → void
 *   getJob(namespace, jobId) → model | null
 *   listJobs(namespace) → model[]
 *   removeJob(namespace, jobId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['putJob', 'getJob', 'listJobs', 'removeJob', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('JobsProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function') throw new Error(`JobsProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'redis',
  'postgresql',
  'storage', // Enterprise Storage Platform (ADR-021)
  'mongodb',
  'message-queue', // external MQ providers
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`jobs: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `jobs provider "${name}" is an extension point — not implemented in Phase 15.3`
    );
  };
  return {
    name,
    planned: true,
    putJob: notImpl,
    getJob: notImpl,
    listJobs: () => [],
    removeJob: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
