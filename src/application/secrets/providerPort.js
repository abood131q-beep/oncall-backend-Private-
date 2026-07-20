'use strict';

/**
 * SecretsProvider PORT (Phase 14.9 / ADR-028 §4) — persistence ONLY. Providers
 * STORE secret + version models; they never rotate, redact, verify integrity, or
 * emit events — all of that lives in the engine, so engine behavior is identical
 * regardless of which provider is active. NOT Vault/AWS/Azure/GCP — those are
 * declared extension points behind this same contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putSecret(namespace, model) → void        // upsert current + append version
 *   getSecret(namespace, name) → model | null // current version
 *   getSecretVersion(namespace, name, version) → model | null
 *   listSecrets(namespace) → model[]          // current version of each
 *   listVersions(namespace, name) → number[]  // ascending version numbers
 *   removeSecret(namespace, name) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putSecret',
  'getSecret',
  'getSecretVersion',
  'listSecrets',
  'listVersions',
  'removeSecret',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('SecretsProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`SecretsProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'vault', // HashiCorp Vault
  'aws-secrets-manager', // AWS Secrets Manager
  'azure-key-vault', // Azure Key Vault
  'gcp-secret-manager', // Google Secret Manager
  'custom', // Bring-your-own adapter
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`secrets: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `secrets provider "${name}" is an extension point — not implemented in Phase 14.9`
    );
  };
  return {
    name,
    planned: true,
    putSecret: notImpl,
    getSecret: notImpl,
    getSecretVersion: notImpl,
    listSecrets: () => [],
    listVersions: () => [],
    removeSecret: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
