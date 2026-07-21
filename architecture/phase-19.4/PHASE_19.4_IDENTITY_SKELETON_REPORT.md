# Phase 19.4 — Identity Kernel Consolidation Skeleton — Report

## Executive Summary

The structural foundation of the **Consolidated Enterprise Identity Kernel** (ADR-049) now exists.
It is **purely additive and inert**: 17 new skeleton files establish the kernel's domain,
application, and infrastructure layers, its ports, DI wiring, provider registry, and metrics/event
hooks — **imported by nothing in production**. **No behavior was moved**; `middleware/auth.js`, the
OTP service, the token gateway, and the identity repository remain the sole authoritative
implementations. Every kernel use case and every infrastructure adapter throws
`IdentityKernelNotWired`, so accidental production use is structurally impossible. All gates are
green and production is byte-identical by construction (the new code is on no request path).

**Verification:** ESLint PASS · Architecture R1–R8 **PASS (0 violations)** — dependency rule, layer
isolation, no cycles all clean · verify:shadow unchanged · unit regression **891/891** (10 new
skeleton tests, incl. an isolation test proving the kernel does not import `middleware/auth.js`) ·
zero production wiring confirmed by scan.

## 1. Consolidated Identity Package

```
src/domain/identity/kernel/          (PURE domain — the single future home of identity concepts)
  principal.js     roles / permissions / claims / principal (frozen VO)
  session.js       session + device identity (VO + isLive predicate)
  policies.js      authorization locus (skeleton — inert until consolidation)
  events.js        identity event vocabulary + pure event factory
  errors.js        IdentityKernelError / IdentityKernelNotWired / IdentityPortError
  index.js         domain barrel
src/application/identity/kernel/      (kernel service + DI, depends on domain only)
  ports.js         REQUIRED_PORTS + assertPorts (fail-fast)
  metrics.js       createIdentityKernelMetrics (no-op counters, snapshot)
  identityKernel.js createIdentityKernel(...) — composes ports/metrics/events; inert use cases
  providers/       provider registry + inert default provider
  index.js         application barrel
src/infrastructure/identity/          (inert port adapters — future owners of the primitives)
  tokenAdapter.js       tokenPort   (future: JWT/refresh/revocation from middleware/auth.js)
  otpAdapter.js         otpPort     (future: services/otpService.js)
  identityRepository.js identityRepositoryPort (future: identity persistence seam)
  sessionStore.js       sessionStorePort (future: session/device persistence)
  index.js              createIdentityInfrastructure(...) composition helper
```

Placed within the ADR-005 layers (per ADR-049) using a `kernel/` subpackage so the existing
production `application/identity` and `domain/identity` files are **untouched**.

## 2. Dependency Diagram

```
  (composition root — FUTURE; e.g. test today)
        │  wires ports → kernel
        ▼
  application/identity/kernel  ── depends on ─►  domain/identity/kernel   (pure)
        │  (assertPorts; DI only)                         ▲
        │                                                 │ implements ports (inward)
        └───────────────  infrastructure/identity ────────┘   (inert: IdentityKernelNotWired)

  Dependency rule (verified by arch gate R4/R5/R6):
    • domain depends on nothing              ✔ R4
    • application depends only on domain     ✔ R5 (never imports infrastructure)
    • no cycles                              ✔ R6
```

## 3. Port Inventory

| Port | Methods (contract) | Future owner (ADR-049) | Status |
|---|---|---|---|
| `tokenPort` | issueAccessToken, verifyAccessToken, issueRefreshToken, verifyRefreshToken, revokeRefreshToken, revokeAllRefreshTokens, revokeAccessTokens | infrastructure/identity token crypto | inert |
| `otpPort` | isRequired, send, verify | infrastructure/identity OTP gateway | inert |
| `identityRepositoryPort` | findUserByPhone, createUser, findDriverByPhone, createDriver, setDriverPresence, recordLoginLog | infrastructure/identity repo adapter | inert |
| `sessionStorePort` | persist, find, revoke | infrastructure/identity session store | inert |
| Optional | eventPublisher, metrics, logger, clock | defaulted at composition | defaulted |

`assertPorts` fails fast (`IdentityPortError`) if any required port or method is missing — verified
by test.

## 4. Provider Registration

`application/identity/kernel/providers/` supplies a `createProviderRegistry()` with
`register / get / list`, seeded with the inert `default` provider (`load()` throws
`IdentityKernelNotWired`). Mirrors the Configuration kernel's provider pattern; real (env/DB-backed)
providers arrive with the consolidation phase.

## 5. Ownership Verification

Every skeleton component maps to an ADR-049 §5 responsibility with exactly one owner, and **no
production responsibility moved**:

| ADR-049 responsibility | Skeleton owner (created) | Authoritative today (unchanged) |
|---|---|---|
| Principal / Roles / Permissions / Claims | `domain/identity/kernel/principal.js` | (payload role in `loginPolicy` / `auth.js`) |
| Session / Device identity | `domain/identity/kernel/session.js` | (JWT payload + driver presence) |
| Authorization | `domain/identity/kernel/policies.js` | `loginPolicy.isAdminPhone` + `auth.js` |
| JWT / Refresh / Revocation | `infrastructure/identity/tokenAdapter.js` | `middleware/auth.js` |
| OTP | `infrastructure/identity/otpAdapter.js` | `services/otpService.js` |
| Identity Repository | `infrastructure/identity/identityRepository.js` | `repositories/identityRepositoryAdapter.js` |
| Token Gateway | `tokenPort` (kernel contract) | `gateways/tokenGatewayAdapter.js` |

The skeleton declares the *future* single owner; the legacy owner remains authoritative until a
migration phase moves each responsibility across the boundary.

## 6. Architecture Validation Report

| Check | Result | Evidence |
|---|---|---|
| Dependency rule (ADR-005) | ✅ | domain pure; application never imports infrastructure |
| Layer isolation | ✅ | kernel in `kernel/` subpackages; production files untouched |
| No circular dependencies | ✅ | arch gate **R6 PASS** |
| R1 no framework in core | ✅ | PASS |
| R2 no SQL outside infra | ✅ | PASS (skeleton has no SQL) |
| R4 domain pure / R5 app downward-only | ✅ | PASS |
| R7 ports asserted | ✅ | PASS (kernel uses `assertPorts`; factory not named `createIdentityApplication`) |
| R8 config-read-seam | ✅ | PASS (unaffected) |
| ADR-049 ownership compliance | ✅ | §5 mapping above; one owner per responsibility |
| Full arch gate | ✅ | **PASS (0 violations)** |

## 7. Regression Report

| Check | Result |
|---|---|
| Zero production wiring (server/onCallApplication/platformBuilder/socket/presentation) | ✅ scan returns NONE — skeleton unimported |
| ESLint (project scope) | ✅ PASS |
| verify:shadow | ✅ unchanged (all 4 shadows 100%) |
| Unit regression (incl. 10 new skeleton tests) | ✅ 891/891 |
| Isolation test (kernel does NOT import middleware/auth.js) | ✅ PASS |
| Existing login / refresh / logout / OTP / sockets | ✅ untouched — the production path (`application/identity`, `middleware/auth.js`, `otpService`, gateways, `routes/auth.js`) has zero code changes; behavior byte-identical by construction |
| DB-backed / integration / A-B / PostgreSQL / security | ⏳ run in CI (sqlite unavailable in sandbox; skeleton adds no runtime path for them to exercise) |

Because the skeleton is imported by nothing on a request path, API responses, JWT format, OTP
behavior, auth/authorization flow, middleware behavior, and the Flutter contract are **unchanged**.

## 8. Success Criteria — met

- ✅ The Consolidated Identity Kernel **exists** (17 files: domain + application + infrastructure,
  ports, DI, providers, metrics, events).
- ✅ **Nothing in production behavior changes** (inert, unwired; 891/891; shadow unchanged).
- ✅ **Flutter requires zero modification** (no API/route/token/OTP change).
- ✅ **API remains byte-identical** (no request path added or altered).
- ✅ The project is **ready for the first responsibility-migration phase** (ports + boundary in place;
  each legacy owner can now be moved behind its port, one at a time, shadow-verified).

## Host Actions

Commit on the host (sandbox `.git/index.lock` FUSE limitation). The inert 18.3
`src/services/__ratchet_probe.js` remains flagged for host-side deletion.

## Next Phase (not started here)

Per ADR-049 §7, the first responsibility migration (recommended: the Token/JWT primitive, or OTP)
would wire one infrastructure adapter to the certified legacy implementation behind its port, stand
up an Identity shadow for that responsibility, and prove 100% parity — before any flag or promotion.
