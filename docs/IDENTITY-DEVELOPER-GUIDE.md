# Enterprise Identity Kernel — Developer Guide (ADR-027)

The Identity Kernel is the platform's unified abstraction for identities, authentication,
sessions, credentials, principals, and authorization context. It is **not an authentication
framework** and **not OAuth/OIDC/Keycloak/Firebase/Cognito/Auth0** — those are provider
extension points. It lives under `identity-kernel/`, separate from the app's identity context.

## 1. Compose

```js
const { createIdentityPlatform } = require('../../src/application/identity-kernel');
const idk = createIdentityPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  sessionTtlMs: 3600000, // default session lease
});
const I = idk.identity;
```

## 2. Register an identity

```js
const pub = await I.register({
  principal: 'user@example.com', // login handle (unique per namespace)
  credentials: { secret: 'password' }, // stored ONLY as a salted hash
  subject: 'user-123', // stable subject id (defaults to principal)
  roles: ['rider'],
  permissions: ['trip:create'],
  claims: { name: 'Rider One' },
  tenant: 't1',
});
// → public model — NEVER contains the credential hash or raw secret
```

## 3. Authenticate → session + authorization context

```js
const { session, context } = await I.authenticate({
  principal: 'user@example.com',
  credentials: { secret: 'password' },
  ttlMs: 3600000,
});
// session: { sessionId, token, expiresAt, ... }
// context: { identityId, principal, subject, tenant, roles, permissions, claims, authenticated }
```

Wrong credentials or an unknown/disabled principal throw `AuthenticationError` (and publish
`AuthenticationFailed`).

## 4. Sessions

```js
await I.refresh({ sessionId, token, ttlMs }); // extend a live session (token-validated)
await I.revoke({ sessionId }); // end a session
```

A refresh on an expired/revoked session, or with a mismatched token, throws `SessionError`.

## 5. Resolve — deterministic authorization context

```js
await I.resolve({ sessionId }); // → { ok: isLive, context } for a session
await I.resolve({ principal }); // → { ok, context } for a principal (no session; authenticated:false)
```

The returned `context` is the frozen authorization context the **Policy engine** (ADR-025)
evaluates: pass `context.roles`, `context.permissions`, `context.tenant`, and `context.claims`
into a policy request.

## 6. Events (through the port only)

`IdentityRegistered`, `Authenticated`, `AuthenticationFailed`, `SessionCreated`,
`SessionRefreshed`, `SessionRevoked` — all via the Event Backbone, producer `identity`.
**No event carries a credential hash or token.** The EventBus is never exposed.

## 7. Observability

```js
idk.metrics.snapshot(); // identities, active sessions, auth attempts/failures, refreshes,
// revocations, provider failures, latency, uptime
idk.metrics.prometheus();
await I.health();
```

## 8. SDK integration (ADR-018)

```js
const { toIdentityPort } = require('../../src/application/identity-kernel/sdkAdapter');
const portFactories = {
  'identity:read': () => toIdentityPort(idk.identity, { owner: extId, canAuthenticate: false }),
  'identity:authenticate': () => toIdentityPort(idk.identity, { owner: extId }),
};
// Inside the extension: this.identity().authenticate({ principal, credentials })
```

Every call is forced into the extension's namespace (`ext.<owner>`), so an extension can only
register/authenticate against its own identities. `authenticate/refresh/revoke/register`
require `identity:authenticate`; `resolve` requires `identity:read`.

## Security

Credentials are stored only as salted sha256 hashes; the raw secret never persists or leaves
the model, and the public model omits even the hash. Sessions are token-validated and
lease-bounded. Namespace isolation and capability gates are enforced at the SDK boundary.

## 8a. Production hardening (added in the completion pass)

```js
await I.snapshotIdentity(namespace, identityId); // deep-frozen, NO credential hash
await I.snapshotSession(namespace, sessionId); // deep-frozen session
I.verifyStartup(); // { ok, problems }
await I.verifyProvider(namespace); // namespace consistency (identities + sessions)
await I.verifyCredentialIntegrity(namespace); // well-formed credential hashes
await I.reconcileSessions({ namespace, now }); // settle expired sessions (stale cleanup)
await I.recover({ namespace, now }); // rebuild the active-session set after a restart
I.diagnostics(namespace); // identities/active/namespaces/startup/metrics
I.history(); // bounded lifecycle log
```

New metric: `identity_expired_sessions_total`. Extra optional dep: `historyLimit`.

## Out of scope (future work behind the provider port)

Real protocol integrations (OAuth2/OIDC/LDAP/SAML/Firebase/Cognito/Auth0), MFA, and token
rotation / JWKS are declared extension points, not implemented in this phase. This is not an
authentication framework.
