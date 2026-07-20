'use strict';

/**
 * IdentityProvider PORT (Phase 14.8 / ADR-027 §4) — persistence OR protocol
 * integration ONLY. Identity behavior (lifecycle, session management, claims,
 * principal resolution) lives in the engine; the provider just stores identity/
 * session models and (for protocol providers) verifies a credential. Business
 * logic never knows which provider is active. NOT an external auth framework.
 *
 * Contract (all async unless noted):
 *   name
 *   putIdentity(namespace, model) → void
 *   getIdentityByPrincipal(namespace, principal) → model | null
 *   getIdentity(namespace, identityId) → model | null
 *   putSession(namespace, model) → void
 *   getSession(namespace, sessionId) → model | null
 *   removeSession(namespace, sessionId) → boolean
 *   listSessions(namespace) → model[]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putIdentity',
  'getIdentityByPrincipal',
  'getIdentity',
  'putSession',
  'getSession',
  'removeSession',
  'listSessions',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('IdentityProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`IdentityProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'oauth2',
  'oidc',
  'ldap',
  'saml',
  'firebase',
  'cognito',
  'auth0',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`identity: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `identity provider "${name}" is an extension point — not implemented in Phase 14.8`
    );
  };
  return {
    name,
    planned: true,
    putIdentity: notImpl,
    getIdentityByPrincipal: notImpl,
    getIdentity: notImpl,
    putSession: notImpl,
    getSession: notImpl,
    removeSession: () => false,
    listSessions: () => [],
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
