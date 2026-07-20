'use strict';

/**
 * Memory identity provider (Phase 14.8 / ADR-027 §4) — in-process persistence of
 * identity + session models. Single-process; the seam a future OAuth/OIDC/LDAP/
 * SAML/Cognito/Auth0 adapter slots behind. It performs no identity behavior —
 * that lives in the engine.
 */

function createMemoryProvider(opts = {}) {
  const ns = new Map(); // namespace -> { identities: Map(id->m), byPrincipal: Map, sessions: Map }
  const bucket = (namespace) => {
    if (!ns.has(namespace)) {
      ns.set(namespace, { identities: new Map(), byPrincipal: new Map(), sessions: new Map() });
    }
    return ns.get(namespace);
  };
  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : m);

  return {
    name: opts.name || 'memory',
    putIdentity(namespace, model) {
      const b = bucket(namespace);
      b.identities.set(model.identityId, clone(model));
      b.byPrincipal.set(model.principal, model.identityId);
      return Promise.resolve();
    },
    getIdentityByPrincipal(namespace, principal) {
      const b = ns.get(namespace);
      if (!b) return Promise.resolve(null);
      const id = b.byPrincipal.get(principal);
      return Promise.resolve(id ? clone(b.identities.get(id)) : null);
    },
    getIdentity(namespace, identityId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.identities.has(identityId) ? clone(b.identities.get(identityId)) : null
      );
    },
    putSession(namespace, model) {
      bucket(namespace).sessions.set(model.sessionId, clone(model));
      return Promise.resolve();
    },
    getSession(namespace, sessionId) {
      const b = ns.get(namespace);
      return Promise.resolve(
        b && b.sessions.has(sessionId) ? clone(b.sessions.get(sessionId)) : null
      );
    },
    removeSession(namespace, sessionId) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? b.sessions.delete(sessionId) : false);
    },
    listSessions(namespace) {
      const b = ns.get(namespace);
      return Promise.resolve(b ? [...b.sessions.values()].map(clone) : []);
    },
    health() {
      let identities = 0;
      let sessions = 0;
      for (const b of ns.values()) {
        identities += b.identities.size;
        sessions += b.sessions.size;
      }
      return { ok: true, provider: 'memory', namespaces: ns.size, identities, sessions };
    },
  };
}

module.exports = { createMemoryProvider };
