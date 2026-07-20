# ADR-027 — Enterprise Identity Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.8 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-024 (Messaging), ADR-025 (Policy),
ADR-026 (Audit)

## Context

The platform needs a unified way to represent identities, authenticate, manage sessions,
carry credentials safely, and produce an authorization context (principal, roles, permissions,
claims, tenant) that other kernels — notably the Policy engine — consume. This is the Identity
Kernel. It is **not an authentication framework** and is **not OAuth/OIDC/Keycloak/Firebase/
Cognito/Auth0** — those are provider extension points, not dependencies.

To stay strictly additive, the kernel lives under `identity-kernel/`; the application's
existing identity bounded context (`src/domain/identity`, `src/application/identity`) is left
completely untouched.

## Decision

Add an additive Identity Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `identity.js` — the Identity value object (identityId, principal, subject, authMethod,
  `credentialHash`, claims, roles, permissions, tenant, metadata, version, state). Credentials
  are stored ONLY as a salted sha256 hash; the raw secret never lives on the model, and
  `toPublic()` strips even the hash.
- `session.js` — the Session value object (sessionId, identityId, principal, tenant, token,
  createdAt/expiresAt/refreshedAt, ttl, version, state) with `isLive`/`settleExpiry`/`refresh`/
  `revoke`.
- `principal.js` — `buildContext(identity, session)`: the deterministic, frozen authorization
  context (roles/permissions/claims/tenant/authenticated) other kernels consume.
- `errors.js` — `IdentityError`, `IdentityValidationError`, `AuthenticationError`,
  `SessionError`.
- `events.js` — the identity event catalog (IdentityRegistered, Authenticated,
  AuthenticationFailed, SessionCreated, SessionRefreshed, SessionRevoked); producer `identity`.

**Application (ports & adapters):**

- `providerPort.js` — persistence/protocol contract (identity + session storage) + declared
  extension points (OAuth2, OIDC, LDAP, SAML, Firebase, Cognito, Auth0, Custom). Providers
  persist or integrate a protocol; identity behavior stays in the engine.
- `providers/memory.js` — the implemented in-process store.
- `metrics.js` — identities, active sessions, auth attempts/failures, refreshes, revocations,
  provider failures, latency, uptime; Prometheus.
- `identityPort.js` — the abstraction contract (`assertIdentity`).
- `identityService.js` — the kernel: `register/authenticate/refresh/revoke/resolve/health`.
  Identity lifecycle, credential verification, session management, claims, and **deterministic
  principal resolution**. Credentials/tokens never appear in events, the SDK, or API responses.
  Lifecycle events through the EventPublisher port only.
- `sdkAdapter.js` — `toIdentityPort(identity, { owner, canRead, canAuthenticate })`: namespace
  isolation + `identity:read`/`identity:authenticate` capability enforcement.
- `index.js` — `createIdentityPlatform(deps)` composition root.

## Kernel integration

Per §5, the Identity Kernel integrates with other kernels **only through their existing ports**
— the Event Backbone (EventPublisher) for lifecycle events; the authorization context it
produces is exactly what the Policy engine (ADR-025) evaluates; and Audit (ADR-026) can record
identity events. It imports no implementation classes.

## Alternatives rejected

- **OAuth/OIDC/Keycloak/Firebase/Cognito/Auth0 as a dependency** — rejected: couples to an
  external auth product. They remain provider extension points behind the port.
- **Storing raw credentials** — rejected: only salted hashes are stored; secrets never persist
  or leave the model.
- **Provider-side identity behavior** — rejected: lifecycle/session/claims logic lives in the
  engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/identity-kernel/**` and `src/application/identity-kernel/**`,
  plus `tests/unit/identity-kernel.test.js` (+14 tests). Zero hot-path change; A/B
  byte-identical. The app's existing identity context is unchanged.
- Real protocol integrations (OAuth/OIDC/etc.), MFA, and token rotation/JWKS are future work
  behind the provider port.

## Rollback

Delete `src/domain/identity-kernel/`, `src/application/identity-kernel/`, and
`tests/unit/identity-kernel.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (and the app's identity context) is unchanged.
