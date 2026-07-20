# Identity Kernel — Provider Guide (ADR-027)

A **provider** handles persistence or protocol integration for one identity technology. It
stores identity + session models and (for protocol providers) may verify a credential; it
performs **no** identity behavior — lifecycle, session management, claims, and principal
resolution live in the engine. Business logic never imports a provider; the composition root
wires it behind the port.

## The provider port

`src/application/identity-kernel/providerPort.js`:

```js
{
  name,
  putIdentity(namespace, model) -> void,
  getIdentityByPrincipal(namespace, principal) -> model | null,
  getIdentity(namespace, identityId) -> model | null,
  putSession(namespace, model) -> void,
  getSession(namespace, sessionId) -> model | null,
  removeSession(namespace, sessionId) -> boolean,
  listSessions(namespace) -> model[],
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. Identity models carry a
`credentialHash` (never a raw secret); protocol providers that authenticate externally can
leave it null and rely on the protocol.

## Implemented adapter

### Memory — `createMemoryProvider({ name? })`

In-process store (`namespace → { identities, byPrincipal, sessions }`). Single process; the
seam a real OAuth/OIDC/LDAP/SAML/Cognito/Auth0 adapter slots behind.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `oauth2`, `oidc`, `ldap`, `saml`, `firebase`, `cognito`, `auth0`, `custom`.
`futureProvider(name)` returns a guard whose operations throw a clear "extension point — not
implemented" error.

## Writing a protocol provider (e.g. OIDC)

A protocol provider maps the engine's identity/session persistence to the IdP, and can
delegate credential verification to the protocol. The engine still owns session lifecycle and
authorization-context resolution.

```js
function createOidcProvider({ store, oidcClient }) {
  return {
    name: 'oidc',
    async putIdentity(ns, model) {
      await store.put(ns, model.identityId, model);
    },
    async getIdentityByPrincipal(ns, principal) {
      /* look up by sub/email */
    },
    async getIdentity(ns, id) {
      /* … */
    },
    async putSession(ns, s) {
      await store.put(`${ns}:sessions`, s.sessionId, s);
    },
    async getSession(ns, id) {
      /* … */
    },
    removeSession(ns, id) {
      /* … */
    },
    listSessions(ns) {
      /* … */
    },
    health: () => ({ ok: true, provider: 'oidc' }),
  };
}
```

Then pass it as `createIdentityPlatform({ provider })`. No business-logic changes; identity
behavior is unchanged.

> Note: real token issuance/rotation (JWT/JWKS), MFA, and IdP redirect flows are designed into
> the adapter + engine in a later phase. The memory provider uses a deterministic token factory
> for tests.

## Guarantees the engine adds on top of any provider

Salted credential hashing (no raw secrets), session lease + token validation, deterministic
principal/authorization-context resolution, lifecycle events, and metrics — so providers stay
focused on persistence/protocol and remain swappable.
