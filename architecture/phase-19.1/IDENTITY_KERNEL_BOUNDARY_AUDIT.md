# Phase 19.1 — Identity Kernel Boundary Audit

**Type:** Assessment only. No code was read-modified; **no implementation is proposed**. Every
finding is cited to `file:line`.

---

## 1. Executive Summary

Identity in the OnCall backend is **bifurcated**, not isolated. Three distinct constructs each own a
slice of "identity," and they are not unified:

1. **The production identity path** — a genuinely clean bounded context
   (`src/application/identity` + `src/domain/identity/loginPolicy.js`) that owns the login / refresh
   / logout **use cases and gates**, wired at `src/presentation/api/identityRoutes.js` and default-on
   (rollback via `IDENTITY_LEGACY=1`, `onCallApplication.js:233-238`). This layer is well-factored.

2. **The cryptographic / token core** — `src/middleware/auth.js`. It holds HS256 JWT issue+verify
   (`96-110`, `198-227`), refresh-token issuance/verification with **direct SQL** (`123-195`), and
   the revocation store (**SQL + in-memory Map + optional Redis fan-out**, `30-88`). This is the real
   token authority, wrapped by `infrastructure/gateways/tokenGatewayAdapter.js`. It lives in
   `src/middleware/` — **outside the four ADR-005 layers the architecture gate audits** — and
   executes SQL, which would violate rule **R2** if that folder were scanned.

3. **The Enterprise Identity Kernel (ADR-027)** — `src/application/identity-kernel` +
   `src/domain/identity-kernel` (principal, session, roles, permissions, credential hashes, claims,
   tenant). It is a full RBAC identity model, **composed** by `platform/platformBuilder.js:66-73`,
   but **non-authoritative, has NO shadow wiring** (`src/enterprise/` contains only config /
   observability / jobs / scheduler shadows), and is **imported by exactly one file**
   (platformBuilder). It sits on no request path — a parallel, aspirational model disconnected from
   the production identity it is named for.

**Headline:** the production identity *use cases* are cleanly bounded, but the identity **primitives**
(JWT crypto, token persistence, revocation, auth middleware, admin determination, OTP) are
**scattered across un-layered `middleware/` and `services/` folders and duplicated across three
owners**. The ADR-027 kernel that should own identity owns nothing in production. Compared with the
Configuration kernel (which had a single read seam → shadow → facade → authoritative), Identity has
**no equivalent seam, no shadow, and an inert adapter** — it is **not ready** for a promotion track
until these boundaries are consolidated. **Enterprise Readiness Score: 46/100 — Not Ready.**

## 2. Identity Responsibility Map

| # | Responsibility | Where it lives | Evidence |
|---|---|---|---|
| R1 | JWT issue / verify (HS256, timing-safe) | `middleware/auth.js` | `96-110`, `198-227` |
| R2 | Access-token expiry policy (15m/24h/30d) | `middleware/auth.js` | `23-25`, `96-97` |
| R3 | Refresh-token issue / verify / rotate (SQL) | `middleware/auth.js` | `123-195` |
| R4 | Token revocation store (SQL + Map + Redis) | `middleware/auth.js` | `30-88`, `72-88` |
| R5 | AuthN middleware (user/driver/passenger/admin) | `middleware/auth.js` | `232-311` |
| R6 | Authorization — admin determination | **duplicated**: `middleware/auth.js:298`, `domain/identity/loginPolicy.js:78`, `domain/identity-kernel/principal.js:17-18` | 3 loci |
| R7 | Login / refresh / logout **use cases** | `application/identity/useCases.js` | `34-175` |
| R8 | Login gates + account-status + session payloads | `domain/identity/loginPolicy.js` | `26-89` |
| R9 | OTP send / verify | `services/otpService.js` (+ `smsService.js`) via `infrastructure/gateways/otpGatewayAdapter.js` | adapter `9-27` |
| R10 | Identity persistence (users/drivers/login_logs) | `infrastructure/repositories/identityRepositoryAdapter.js` | `12-34` |
| R11 | Session / device presence + socket auth | `identityRepositoryAdapter.setDriverPresence` (`21-24`), `socket.js:17,48`, `infrastructure/gateways/driverSessionControlAdapter.js` | scattered |
| R12 | Token gateway (wraps R1–R4) | `infrastructure/gateways/tokenGatewayAdapter.js` | `10-32` |
| R13 | Enterprise Identity Kernel (principal/session/roles/permissions/credentials) | `application/identity-kernel/*`, `domain/identity-kernel/*` | `identityService.js:1-70`, `identity.js:40-49` |
| R14 | Identity Adapter (JWT→principal, verify) — **INERT** | `platform-adapters/identity/index.js` | `12-27` (port null) |
| R15 | Legacy auth routes (rollback duplicate) | `routes/auth.js` (319 lines) | `onCallApplication.js:233-235` |

## 3. Identity Boundary Diagram

```
                          ┌──────────────────── PRODUCTION REQUEST PATH ─────────────────────┐
  HTTP ─► identityRoutes.js ─► identityController ─► application/identity (use cases) ─► domain/identity/loginPolicy
                                                          │        │         │
                                       tokenGatewayAdapter│  otpGateway│  identityRepositoryAdapter
                                                          ▼        ▼         ▼
                                          middleware/auth.js   services/otpService   userRepo + driverRepo + login_logs
                                          (JWT + refresh SQL +  (+ smsService)        (cross-context persistence)
                                           revocation SQL/Redis)
                                                          ▲
  every protected route (18 modules) ── svc.authenticate ─┘   socket.js ── verifyJWT (direct)

  ┌──────────── ENTERPRISE (composed, NON-authoritative) ────────────┐
  platformBuilder ─► application/identity-kernel ─► domain/identity-kernel (principal/session/roles/permissions)
        │                                   (imported by 1 file; on NO request path; NO shadow)
        └─► platform-adapters/identity (INERT: port=null) ─X─ not consumed
```

The two boxes **do not touch**. The enterprise kernel is not wired to the production path in any
mode; the adapter that would bridge them is inert.

## 4. Boundary Violations

| ID | Violation | Owner now → correct | Sev | Evidence |
|---|---|---|---|---|
| V1 | **JWT crypto in the middleware layer** (transport folder holds cryptographic issuance/verification) | `middleware/auth.js` → Identity (domain policy + infra crypto) | High | `auth.js:96-110,198-227` |
| V2 | **Direct SQL outside `infrastructure/`** (refresh + revocation tables) — escapes arch rule R2 because `middleware/` is unscanned | `middleware/auth.js` → Identity infrastructure repo | High | `auth.js:47,77,129,157,183,194` |
| V3 | **Authorization scattered / duplicated** (admin determination in 3 places; RBAC roles/permissions modeled only in the unused kernel) | 3 loci → single Identity authorization owner | High | `auth.js:298`, `loginPolicy.js:78`, `identity-kernel/principal.js:17-18` |
| V4 | **Duplicate identity domains** — `domain/identity` (used) vs `domain/identity-kernel` (unused) model the same concepts (session, principal) | two → one | High | `domain/identity/*` vs `domain/identity-kernel/*` |
| V5 | **Enterprise Identity Kernel is dead ownership** — composed but non-authoritative, no shadow, 1 importer, no request path | kernel owns nothing → should own identity (post-consolidation) | High | `platformBuilder.js:66-73`; no `identityShadow` in `enterprise/` |
| V6 | **Session/device identity split** across drivers context + socket layer; no session entity owns it | drivers/socket → Identity session | Medium | `identityRepositoryAdapter.js:21-24`, `socket.js:17,48` |
| V7 | **OTP logic in un-layered `services/`** (not a scanned layer), wrapped late by a gateway | `services/otpService.js` → Identity infrastructure | Medium | `otpGatewayAdapter.js:9`, `services/otpService.js` |
| V8 | **Cross-context persistence reach** — identity repo adapter reads `userRepo`+`driverRepo` and writes `login_logs` | acceptable adapter, but couples Identity to two contexts' storage | Medium | `identityRepositoryAdapter.js:13-32` |
| V9 | **Socket auth couples to middleware crypto directly** (not via an Identity port) | `socket.js` → Identity port | Low | `socket.js:17,48` |
| V10 | **Legacy `routes/auth.js` duplicate** retained as rollback (319 lines of parallel login logic) | intentional rollback debt | Low | `onCallApplication.js:233-235` |

Inert-by-design (NOT violations): `platform-adapters/identity` (correctly inert, `port=null`), the
token/otp/identity gateway adapters (correct infrastructure wrappers).

## 5. Responsibility Ownership Matrix

| Responsibility | Current owner | Correct owner (target) | Boundary violation? |
|---|---|---|---|
| JWT sign/verify | `middleware/auth.js` (unlayered) | Identity (domain policy + infra crypto) | **Yes** (V1) |
| Refresh token persistence | `middleware/auth.js` (SQL) | Identity infrastructure | **Yes** (V2) |
| Revocation store | `middleware/auth.js` (SQL/Map/Redis) | Identity infrastructure | **Yes** (V2) |
| AuthN middleware | `middleware/auth.js` | Identity edge (via Identity port) | Partial (V1/V3) |
| Authorization (roles/admin/permissions) | 3 loci (auth + loginPolicy + kernel) | Single Identity authorization owner | **Yes** (V3) |
| Login/refresh/logout use cases | `application/identity` | `application/identity` | No ✅ |
| Login gates / account status | `domain/identity/loginPolicy` | `domain/identity` | No ✅ (reads cross-context data) |
| OTP send/verify | `services/otpService` | Identity infrastructure gateway | Partial (V7) |
| Identity persistence | `infrastructure/repositories/identityRepositoryAdapter` | Identity infrastructure | Partial (V8) |
| Session/device presence | drivers + socket | Identity session | **Yes** (V6) |
| Enterprise Identity Kernel | `application/identity-kernel` (unused) | Identity kernel (should be authoritative post-consolidation) | **Yes** (V5) |
| Identity adapter | `platform-adapters/identity` (inert) | inert until seam exists | No ✅ |

## 6. Coupling Analysis

**Afferent coupling (fan-in):**
- **Identity edge middleware (`svc.authenticate*`): 18 route/presentation modules** depend on it —
  every bounded context's protected routes. Expected for an auth edge, but the dependency is on
  `middleware/auth.js`, **not** an Identity kernel port, so there is no seam to shadow or re-point
  (contrast the Configuration facade, which gave exactly such a seam).
- `middleware/auth.js`: 4 direct importers (`onCallApplication.js` DI wiring, `socket.js`, tests).
- `application/identity`: **1** importer (`identityRoutes.js`) — clean, single entry point.
- `application/identity-kernel`: **1** importer (`platformBuilder.js`) — isolated but **unused**;
  the Policy kernel declares `dependsOn: ['config, identity']` in the composed graph only
  (`platformBuilder.js:75-77`), not in production.

**Efferent coupling (fan-out) of the production context:** `application/identity` depends on 5
injected ports (identityRepository, tokenGateway, otpGateway, auditLog, adminPhones) — clean DI,
good direction (`useCases.js:35`).

**Cohesion:**
- `application/identity` — **High** (single responsibility: session lifecycle).
- `domain/identity/loginPolicy` — **High** (pure decisions).
- `middleware/auth.js` — **Low** (crypto + SQL + middleware + authz in one un-layered file).
- `identity-kernel` — internally High, but **zero cohesion with the production identity it names**.

**Layer / dependency / infrastructure-leakage findings:**
- **Infra leakage into `middleware/`:** raw SQL (`auth.js:47,77,129,157,183,194`) and Redis
  revocation fan-out (`auth.js:60-88`) — infrastructure concerns in a transport folder.
- **Governance blind spot:** `middleware/` and `services/` are **not** among the four layers the
  architecture gate scans (`verify-architecture.mjs` LAYERS = domain/application/infrastructure/
  presentation), so R2 ("no SQL outside infrastructure") never sees `auth.js`'s SQL.
- **Duplicate domain trees** (`domain/identity` vs `domain/identity-kernel`) — DRY/ownership breach.
- **No identity read-seam:** production reads identity via `middleware/auth` functions and
  `svc.authenticate`, not through an Identity port/facade — there is nothing a kernel could back.

## 7. Enterprise Readiness Score — 46 / 100 (Not Ready)

| Dimension | Weight | Score | Rationale |
|---|---|---|---|
| Bounded-context isolation (use cases) | 15 | 12 | `application/identity` is clean and single-entry |
| Single source of truth | 20 | 4 | Identity split across 3 owners; crypto+authz duplicated |
| Layer compliance | 15 | 5 | JWT crypto + SQL in un-scanned `middleware/`; OTP in `services/` |
| Kernel isolation (ADR-027) | 15 | 6 | Kernel exists but disconnected/unused — architectural drift |
| Promotion seam (shadow/facade like Config) | 20 | 3 | No identity port seam, no shadow, inert adapter |
| Coupling health | 10 | 8 | Clean DI in the context; wide but funneled edge coupling |
| Security-core containment | 5 | 8 | Crypto is correct & certified, just mislocated |
| **Total** | **100** | **46** | **Not ready — consolidation required before any shadow/promotion track** |

Interpretation: **46/100 — "Scattered-but-partially-bounded."** The production use cases are
promotable-quality; the primitives and authorization are not. Identity is roughly where
Configuration was *before* Phase 18.3 (no seam) — but worse, because of the duplicate kernel and the
crypto/SQL-in-middleware violations.

## 8. Recommendations (directional — assessment only, no implementation)

1. **Resolve the duplicate-kernel question first (V4/V5).** Decide, by ADR, whether
   `identity-kernel` (ADR-027 RBAC model) or the production `domain/identity` context is the future
   authoritative Identity kernel. Two domains for one concept must become one before any promotion.
2. **Establish a single Identity read-seam** analogous to the Configuration facade — one port
   through which `verify` / `resolve current user` / `authorize` flow — so a shadow could later
   compare and a promotion could re-point. Today no such seam exists; this is the top prerequisite.
3. **Relocate the identity primitives out of `middleware/` and `services/`** into the Identity
   infrastructure/domain (crypto, refresh/revocation persistence, OTP) so they fall under the
   ADR-005 layers and the R2 SQL rule — closing V1, V2, V7.
4. **Unify authorization ownership (V3):** one owner for role/admin/permission determination;
   eliminate the triplicated admin check.
5. **Extend the architecture gate to scan `middleware/` and `services/`** (governance blind spot) so
   identity SQL/crypto is no longer invisible to R2/R-rules.
6. **Consolidate session/device identity (V6)** under an Identity session owner rather than the
   drivers context + socket layer.
7. **Sequence any promotion as Config did:** consolidate → seam → shadow (100% parity) → flag-gated
   authoritative → A/B + soak → ADR. Identity is **not** at the shadow stage yet; do not open a
   promotion phase until items 1–3 are closed.

**Do not begin implementation on the basis of this audit** — it is evidence and direction only. Each
recommendation should be chartered as its own ADR-governed phase.
