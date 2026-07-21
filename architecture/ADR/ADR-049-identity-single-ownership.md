# ADR-049 — Identity Single Ownership (Consolidated Enterprise Identity Kernel)

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Principal Engineering
- **Related:** ADR-027 (Identity Kernel), ADR-005 (Layered Architecture / Dependency Rule),
  ADR-046 (Enterprise Shadow Integration), ADR-047 (Kernel Ownership Preconditions), ADR-048
  (Configuration Kernel Authoritative Promotion — reference methodology), Phase 19.1 (Identity
  Kernel Boundary Audit), Phase 19.2 (Identity Single Ownership Decision)
- **Supersedes on the ownership question:** the implicit split between `application/identity`,
  `src/middleware/auth.js`, and `application/identity-kernel`.

---

## 1. Background — how Identity ownership became fragmented

Identity in the OnCall backend accreted over multiple eras rather than being designed as one kernel:

- The original authentication was implemented as Express **middleware** (`src/middleware/auth.js`):
  hand-rolled HS256 JWT, refresh tokens, and a revocation store — the certified, production security
  core, but located in a transport folder.
- A later **strangler migration** extracted the login/refresh/logout decisions into a clean bounded
  context (`src/application/identity` + `src/domain/identity/loginPolicy.js`), which became the
  production default (rollback via `IDENTITY_LEGACY=1`). It correctly wrapped the middleware crypto
  behind a token gateway rather than reimplementing it.
- Separately, the Enterprise platform introduced a **new Identity Kernel** (`identity-kernel`,
  ADR-027) with a full RBAC model (principal, session, roles, permissions, claims, credentials) as
  one of the 25 composed kernels — but it was never wired to production.

The result (established by the Phase 19.1 audit, used here as authoritative evidence — not
re-audited): **three constructs each own a slice of identity, and they do not touch.**

### Summary of Phase 19.1 findings

- **Production use cases are cleanly bounded** (`application/identity`, single importer, high
  cohesion, byte-identical A/B harness) — good.
- **The security primitives are mislocated and duplicated:** JWT crypto + refresh/revocation with
  **direct SQL** live in `src/middleware/auth.js` (`96-110`, `123-195`, `30-88`), a folder the
  architecture gate does **not** scan — so its SQL escapes rule R2 (governance blind spot).
- **Authorization is triplicated** (admin/role determination in `middleware/auth.js:298`,
  `domain/identity/loginPolicy.js:78`, and `domain/identity-kernel/principal.js`).
- **Two identity domain models coexist** (`domain/identity` vs `domain/identity-kernel`).
- **The ADR-027 kernel is dead ownership** — composed by `platformBuilder`, non-authoritative, **no
  shadow**, one importer, on no request path.
- **No Identity read-seam exists** — nothing a shadow could compare or a promotion could re-point.
- Enterprise Readiness Score: **46/100 — Not Ready.**

## 2. Problem Statement

1. **Multiple identity owners.** No single component owns "identity"; responsibility is split across a
   bounded context, an un-layered middleware file, and an unused kernel.
2. **Duplicate identity models.** `domain/identity` (session payloads, login gates) and
   `domain/identity-kernel` (principal, session, roles, permissions) model the same concepts twice.
3. **Middleware ownership.** The most security-critical code (JWT, refresh, revocation) sits in
   `src/middleware/` with embedded SQL — outside the ADR-005 layers and invisible to the R2 SQL rule.
4. **Enterprise Kernel isolation.** The ADR-027 Identity Kernel owns nothing in production; it is a
   parallel, aspirational model disconnected from the identity it names.
5. **Governance issues.** With three owners and no single seam, every future identity change risks
   re-litigating ownership, there is no shadow/promotion path, and boundary violations are
   structurally undetectable by the current architecture gate.

## 3. Decision

**The Consolidated Enterprise Identity Kernel is the permanent and single owner of all Identity
responsibilities in the OnCall Platform.**

This kernel is formed by consolidating the three current constructs into one:
- it takes its **authoritative behavior and OnCall domain** from the production bounded context
  (`application/identity` + `domain/identity`);
- it takes its **enterprise structure and RBAC model** (principal / session / roles / permissions /
  claims, provider / metrics / events) from `identity-kernel` (ADR-027);
- it **absorbs the primitives** currently in `src/middleware/auth.js` (JWT crypto, refresh,
  revocation) and `src/services/otpService.js` (OTP) into proper Identity infrastructure;
- it exposes a **single Identity port** (`platform-adapters/identity`, today inert) as the one seam
  through which the edge middleware and sockets consume identity.

The previously separate owners (`middleware/auth.js`, `services/otpService.js`, `identity-kernel`)
are **dissolved into** this kernel; they do not persist as parallel owners. **This decision is
final** (per Phase 19.2, Option C chosen; Options A and B rejected).

## 4. Ownership Principles

- **Single Owner.** Exactly one component — the consolidated Identity Kernel — owns identity. No
  second identity owner may be introduced.
- **Single Source of Truth.** One identity domain model; duplicate domains/kernel are dissolved.
  Authorization (admin/role/permission) has exactly one locus.
- **Clean Architecture (ADR-005).** `domain/identity` is pure (no I/O, no framework);
  `application/identity` depends only on the domain; `infrastructure/identity` implements ports.
- **Dependency Rule.** Dependencies point inward/downward only. Crypto/SQL/OTP move from
  middleware/services into `infrastructure/identity`; no inner layer depends on an outer one.
- **Enterprise Kernel principles.** The kernel is a dependency-injected service with provider /
  metrics / events ports and a single adapter seam — the same shape as the other Enterprise kernels
  (ADR-016+), making it shadow- and promotion-capable.

## 5. Ownership Boundaries (permanent — exactly one owner each)

| Responsibility | Permanent owner (within the consolidated Identity Kernel) |
|---|---|
| Authentication | `application/identity` — authenticate use case |
| Authorization (admin / role / permission determination) | `domain/identity` — authorization policy + principal (the ONLY locus) |
| JWT (sign / verify) | `infrastructure/identity` — token crypto |
| Refresh Tokens | `infrastructure/identity` — token/session persistence |
| Session Management | `domain/identity` (session entity) + `infrastructure/identity` (persistence) |
| Device Identity | `domain/identity` — session/device sub-domain (socket edge consumes via the port) |
| OTP | `infrastructure/identity` — OTP gateway |
| Identity Policies | `domain/identity` |
| Principal | `domain/identity` |
| Roles | `domain/identity` — principal |
| Permissions | `domain/identity` — principal |
| Claims | `domain/identity` — principal |
| Identity Repository | `infrastructure/identity` — identity repository adapter (reads Users/Drivers repos via ports) |
| Token Gateway | `infrastructure/identity` |

**Boundary clarification (no duplicate ownership):** account-lifecycle **status data**
(`user.is_active`, `driver.approval_status`) remains owned by the **Users / Drivers** contexts.
Identity owns only the **gate** that interprets that status at login/refresh, and consumes the datum
**via a port** — consumption, not ownership. Likewise the Identity repository adapter owns the
identity-repo **seam**, not the foreign Users/Drivers entities it reads.

## 6. Non-Goals

This ADR is **governance only**. It explicitly performs:
- **no migration** — nothing is moved or merged by this ADR;
- **no implementation** — no code is written or changed;
- **no production changes** — runtime behavior is untouched (`IDENTITY_LEGACY` and the current path
  remain exactly as they are);
- **no API changes** — no route, status code, JSON shape, header, or token format changes;
- **no Flutter changes** — the mobile contract is unaffected.

It records the **target ownership model** only. Execution is deferred to future, separately-chartered
phases.

## 7. Future Migration Strategy (reference only — no implementation details)

Future Identity work will follow the promotion methodology proven by Milestone M1 (Configuration,
ADR-048), in this order, each as its own governed phase:

```
Consolidation → Identity Port → Shadow → A/B → Flag → Production Soak → Authoritative Promotion
```

- **Consolidation** — unify the domains and relocate the primitives behind the kernel.
- **Identity Port** — make the single `platform-adapters/identity` seam load-bearing.
- **Shadow** — run the consolidated kernel non-authoritatively at 100% parity.
- **A/B** — prove byte-identical HTTP responses across a flag.
- **Flag** — `IDENTITY_AUTHORITATIVE` (or equivalent), default OFF, instant rollback.
- **Production Soak** — zero-drift observation window + Owner sign-off.
- **Authoritative Promotion** — enable the flag; record in the Promotion History.

Implementation specifics are intentionally **not** defined here.

## 8. Consequences

**Benefits**
- One identity owner and one source of truth; the 19.1 violations (V1–V9) become closable.
- The security primitives move under the audited ADR-005 layers (crypto/SQL/OTP no longer invisible).
- A single Identity seam enables the Config-style shadow → authoritative promotion track.
- First-class RBAC (principal/roles/permissions/claims) becomes available for future authorization
  needs without a second model.

**Trade-offs**
- Consolidation is the highest up-front effort of the three options (Phase 19.2 matrix) and touches
  the certified auth core — execution risk that must be de-risked by shadow + A/B + soak in later
  phases (not now).
- Until consolidation runs, the current split persists (this ADR sets direction, not state).

**Future constraints**
- No new identity owner may be introduced; all identity work targets the consolidated kernel.
- Authorization logic must live in the single `domain/identity` locus — no re-duplication.
- Any promotion must follow ADR-047 gates + the M1 methodology; no shortcut to authoritative.

## 9. Governance

**ADR-049 is the architectural source of truth for all future Identity phases.** Every subsequent
Identity decision, audit, consolidation, shadow, or promotion must conform to this ownership model
and cite this ADR. The ownership question is **closed**: future phases reference ADR-049 rather than
re-debating who owns identity. Amendments require a new superseding ADR.

---

## Appendix A — Ownership Diagram (target)

```
                          ┌───────────────── ONE IDENTITY OWNER ─────────────────┐
                          │        Consolidated Enterprise Identity Kernel        │
   edge middleware  ─┐    │                                                       │
   (authenticate*)   ├──► platform-adapters/identity  (the single Identity port / seam)
   socket handshake ─┘    │                        │                              │
                          │        ┌───────────────┴───────────────┐              │
                          │        ▼                               ▼              │
                          │  application/identity  ─────►   domain/identity        │
                          │  (authenticate, refresh,        (principal, roles,      │
                          │   logout, resolve, authorize;    permissions, claims,   │
                          │   provider/metrics/events)       session, policies,     │
                          │        │                         login/refresh gates)   │
                          │        ▼                                                │
                          │  infrastructure/identity                                │
                          │  (JWT crypto · refresh+revocation · OTP · identity repo  │
                          │   adapter · token gateway)                              │
                          └────────────────────┬───────────────────────────────────┘
                                               │  (ports; downward/inward only)
                                               ▼
                          Users repo · Drivers repo · login_logs   (owned elsewhere;
                                                                    Identity consumes via ports)

   DISSOLVED INTO THE KERNEL (no longer separate owners):
     middleware/auth.js (crypto/SQL) · services/otpService.js (OTP) · identity-kernel (ADR-027 shell)
```

## Appendix B — Layer / Dependency Diagram (Clean Architecture)

```
   [ edge middleware / sockets ]         ← consume via the Identity port only
              │  (inward)
              ▼
   [ platform-adapters/identity ]        ← single seam (shadow/promotion point)
              │
              ▼
   [ application/identity ]  ── depends on ─►  [ domain/identity ]   (pure; depends on nothing)
              ▲                                        ▲
              │ implements ports                       │ implements ports
   [ infrastructure/identity ] ────────────────────────┘
     (JWT · refresh/revocation · OTP · repo adapter · token gateway)

   Dependency rule: outer → inner only. Domain is pure. Infrastructure implements ports.
```

## Appendix C — References

- Phase 19.1 — `architecture/phase-19.1/IDENTITY_KERNEL_BOUNDARY_AUDIT.md` (authoritative evidence).
- Phase 19.2 — `architecture/phase-19.2/IDENTITY_SINGLE_OWNERSHIP_DECISION.md` (Option C decision,
  comparison matrix 49 vs 36 vs 33).
- ADR-027 (Identity Kernel), ADR-005 (layers/dependency rule), ADR-046/047 (shadow/ownership gates),
  ADR-048 + Milestone M1 (reference promotion methodology).
