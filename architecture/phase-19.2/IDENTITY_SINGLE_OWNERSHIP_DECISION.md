# Phase 19.2 — Identity Single Ownership Decision

**Type:** Decision only. No code, no ADR, no migration plan. Evidence source: Phase 19.1 Identity
Kernel Boundary Audit (`architecture/phase-19.1/IDENTITY_KERNEL_BOUNDARY_AUDIT.md`).

**Decision:** ✅ **Option C — merge both into a single, consolidated Enterprise Identity Kernel.**
Options A and B are **rejected**.

---

## 1. Executive Summary

Phase 19.1 proved Identity is bifurcated across three owners: a clean production bounded context
(`application/identity` + `domain/identity`), an un-layered crypto/token core (`middleware/auth.js`,
with SQL), and a disconnected Enterprise Identity Kernel (`identity-kernel`, ADR-027). Establishing a
single owner requires choosing between evolving the production context (A), adopting the kernel
wholesale (B), or consolidating both into one kernel (C).

**Option C is the only model that achieves all mandated principles simultaneously** — single owner,
single source of truth, Clean Architecture, Enterprise-Kernel structure, and future shadow /
authoritative-promotion compatibility — **while preserving the proven, certified production
behavior**. Option A keeps production safe but leaves the crypto/SQL-in-middleware violations
(19.1 V1/V2) unresolved and provides no kernel seam to shadow or promote (fails the enterprise and
promotion criteria). Option B is architecturally clean but does **not own the OnCall identity domain**
(no phone/OTP, driver-approval, `ADMIN_PHONES`, refresh-SQL modeling), and adopting it means rewriting
the live authentication path — the highest possible production risk. The consolidated kernel takes the
**behavior + domain** from the production context and the **enterprise structure + RBAC model**
(principal / session / roles / permissions / claims) from the ADR-027 kernel, absorbing the
`middleware/` and `services/` primitives into proper Identity infrastructure. After the merge there is
**exactly one Identity owner**, and every identity responsibility maps to exactly one component.

The consolidation cost (migration complexity) is real but is a **future, sequenced concern** —
mitigable by the exact methodology Milestone M1 established for Configuration (seam → shadow → flag →
A/B → soak → authoritative). It does not change this phase's conclusion; this phase fixes direction
only.

## 2. Option Comparison Matrix

Scored 1–5 per criterion (5 = best). Evidence cited to 19.1 where relevant.

| Criterion | A: evolve `application/identity` | B: adopt `identity-kernel` | C: consolidate both |
|---|---|---|---|
| Architectural correctness | 3 (clean context, but crypto/SQL in middleware — V1/V2) | 3 (proper kernel, but mismodels OnCall domain) | **5** (resolves V1–V9; kernel + real domain) |
| Domain ownership | 4 (owns OnCall login domain) | 1 (no phone/OTP/driver-approval/ADMIN_PHONES) | **5** (owns full OnCall identity + RBAC) |
| Clean Architecture compliance | 3 (middleware SQL escapes R2) | 5 (textbook) | **5** (layers correct, crypto relocated) |
| Long-term maintainability | 3 | 3 (clean but detached from reality) | **5** (one owner, SSOT) |
| Migration complexity (5=low) | **5** (already production) | 1 (rebuild live auth) | 2 (highest up-front; sequenced) |
| Risk (5=low) | **5** (no change) | 1 (replace certified auth) | 3 (moderate; shadow/flag-mitigated) |
| Production impact (5=none) | **5** (none) | 1 (rewrites live path) | 4 (zero-impact achievable via shadow→flag) |
| Future extensibility | 2 (no principal/permissions/claims) | 5 (full RBAC/tenant) | **5** (full RBAC/tenant) |
| Enterprise scalability | 2 (not a kernel) | 5 (native kernel) | **5** (native kernel) |
| Governance compatibility | 2 (outside kernel family) | 5 (ADR-027 family) | **5** (ADR-027 family) |
| Promotion readiness | 2 (no port seam/shadow) | 3 (structure yes, nothing to promote) | **5** (produces the Config-style seam) |
| **Total (/55)** | **36** | **33** | **49** |

## 3. Decision Rationale

**Why C (chosen).** Only C satisfies every mandated architecture principle *and* preserves production
behavior. It directly closes the 19.1 violations: V1/V2 (relocate JWT crypto + refresh/revocation SQL
out of `middleware/` into Identity infrastructure), V3 (one authorization owner), V4/V5 (dissolve the
duplicate domains and the dead kernel into one), V6/V7 (session/device + OTP owned by Identity). It
yields the one thing Identity lacks today and Configuration had before its promotion: **a single
Identity port/seam** through which reads flow — the prerequisite for a shadow and an authoritative
promotion. Its weak dimensions (migration complexity, risk) are future-phase and are precisely what
the M1 methodology was built to de-risk.

**Why not A.** `application/identity` is the correct *behavioral* baseline but is **not an Enterprise
Kernel**: it has no principal/roles/permissions/claims model, no kernel service (provider/metrics/
events), and it still delegates the security core to `middleware/auth.js` where SQL and crypto sit
outside the audited layers (19.1 V1/V2, governance blind spot). Choosing A would freeze those
violations and leave no promotion seam — it fails architectural correctness, enterprise scalability,
extensibility, governance, and promotion-readiness. (A is, however, the correct *source of behavior*
that C absorbs.)

**Why not B.** `identity-kernel` is a clean kernel that **owns none of the actual OnCall identity
domain** (19.1: composed but non-authoritative, 1 importer, no request path, memory provider,
secret-credential model rather than phone/OTP/JWT/driver-approval). Selecting B means rebuilding the
certified live authentication on an unproven model — maximal risk and production impact, and it still
would not natively express the OnCall domain. (B is, however, the correct *source of structure/RBAC*
that C absorbs.)

**Evidence over preference:** the matrix (49 vs 36 vs 33) and the violation-closure analysis both
point to C; A and B each score high only on the axes that are the *opposite* of the other's, and
neither closes the boundary violations alone.

## 4. Final Ownership Model

**Single owner:** **the consolidated Enterprise Identity Kernel** (the unified `identity` kernel,
ADR-027 lineage). It is the sole owner of all identity responsibilities. Its internal structure
(target):

- **`domain/identity`** — pure identity domain: principal, roles, permissions, claims, session
  entity, identity policies, login/refresh/account-status gates. (Absorbs today's
  `domain/identity/loginPolicy` **and** `domain/identity-kernel/{principal,session,identity}`.)
- **`application/identity`** — the Identity Kernel service + use cases (authenticate, refresh, logout,
  resolve current principal, authorize), provider/metrics/events ports. (Absorbs today's
  `application/identity` use cases **and** `application/identity-kernel` service structure.)
- **`infrastructure/identity`** — token crypto (JWT), refresh-token + revocation persistence, OTP
  gateway, identity repository adapter, token gateway. (Absorbs `middleware/auth.js` crypto/SQL and
  `services/otpService.js`.)
- **`platform-adapters/identity`** — the single Identity **port/seam** (today inert) through which the
  edge middleware and sockets consume identity — the future shadow/promotion point.

The other two constructs cease to exist as owners: `middleware/auth.js`, `services/otpService.js`, and
`identity-kernel` are **dissolved into** the consolidated kernel (not kept in parallel). `routes/auth.js`
(legacy rollback) is retired once the merge is behavior-proven.

## 5. Responsibility Matrix (exactly one owner each — no duplicates)

| Responsibility | Single owner (within the consolidated Identity Kernel) |
|---|---|
| Authentication | `application/identity` — authenticate use case |
| Authorization (admin/role/permission determination) | `domain/identity` — authorization policy + principal (the ONLY admin/role locus) |
| JWT (sign/verify) | `infrastructure/identity` — token crypto |
| Refresh Tokens | `infrastructure/identity` — token/session persistence |
| Session Management | `domain/identity` (session entity) + `infrastructure/identity` (persistence) |
| Device Identity | `domain/identity` — session/device sub-domain (consumed by socket edge via the port) |
| OTP | `infrastructure/identity` — OTP gateway |
| Identity Policies | `domain/identity` |
| Roles | `domain/identity` — principal |
| Permissions | `domain/identity` — principal |
| Claims | `domain/identity` — principal |
| Principal | `domain/identity` — principal |
| Account Status (identity gate) | `domain/identity` — login/refresh gates *interpret* status. NOTE: the underlying account-lifecycle status (`user.is_active`, `driver.approval_status`) remains owned by the **Users / Drivers** contexts as their data; Identity **consumes it via a port** and owns only the gate, not the datum. |
| Identity Repository (adapter/port) | `infrastructure/identity` — identity repository adapter (reads Users/Drivers repos via ports; owns the identity-repo seam, not the foreign entities) |
| Token Gateway | `infrastructure/identity` |

Every row has exactly one owner. The only cross-context relationships (account-status data, user/
driver persistence) are **consumption via ports**, not shared ownership — so there are no duplicate
owners.

## 6. Target Architecture

```
              edge middleware (authenticate*)  +  socket handshake
                              │  (consume via ONE Identity port)
                              ▼
                 platform-adapters/identity  ── the single Identity seam (shadow/promotion point)
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                            ▼
  application/identity  ──────────────────►  domain/identity
  (kernel service + use cases:               (principal, roles, permissions, claims,
   authenticate/refresh/logout/               session, identity + login/refresh/account gates)
   resolve/authorize; provider/
   metrics/events ports)
        │
        ▼
  infrastructure/identity
  (JWT crypto · refresh+revocation persistence · OTP gateway · identity repo adapter · token gateway)
        │  (ports outward, downward only — ADR-005 dependency rule)
        ▼
  Users repo · Drivers repo · login_logs   (owned by their contexts; Identity consumes via ports)
```

Dependency direction is strictly inward/downward (presentation/edge → application → domain;
infrastructure implements ports) — satisfying the Clean Architecture dependency rule.

**Principle compliance check (chosen model):**

| Principle | Satisfied? | How |
|---|---|---|
| Single Owner | ✅ | One consolidated Identity Kernel owns all identity |
| Single Source of Truth | ✅ | Duplicate domains/kernel dissolved into one |
| Clean Architecture | ✅ | domain pure; application depends on domain; infrastructure implements ports |
| Dependency Rule | ✅ | crypto/SQL move into infrastructure; no inward dependency on outer layers |
| Enterprise Kernel principles | ✅ | kernel service with provider/metrics/events; port seam; RBAC model |
| Future Shadow compatibility | ✅ | the single Identity port is the comparison seam a shadow needs |
| Future Authoritative Promotion compatibility | ✅ | seam + flag → the exact Config-style promotion track |

## 7. Risks

| Risk | Severity | Nature |
|---|---|---|
| Migrating the certified JWT/refresh/revocation core out of `middleware/auth.js` could regress live sessions | High | Mitigable later via strangler + shadow + A/B (M1 methodology); this phase changes nothing |
| Reconciling two domain models (loginPolicy vs principal/session) into one | Medium | Design effort; behavior must remain the production baseline (A is the behavioral truth) |
| Account-status coupling to Users/Drivers | Low | Kept as port consumption, not ownership — already the pattern today |
| Scope creep into RBAC before it is needed | Low | Adopt principal/roles/permissions structurally; enable richer authz only when required |
| Legacy `routes/auth.js` retained too long | Low | Retire after behavior parity is proven |

No risk materializes in this phase — it is a decision. All execution risk belongs to future,
ADR-governed phases.

## 8. Migration Readiness (assessment only — not a plan)

- **Behavioral baseline exists and is proven:** `application/identity` is production-default with a
  byte-identical A/B harness (`tests/integration/identity-ab.mjs`) — the merge has a certified target
  behavior to preserve.
- **Structural target exists:** `identity-kernel` provides the kernel shell (provider/metrics/events/
  principal/session) to adopt.
- **Seam exists but is inert:** `platform-adapters/identity` is present (`port=null`) — the promotion
  seam is scaffolded, not yet load-bearing.
- **Methodology exists:** Milestone M1 (Configuration) is the reusable promotion pattern.
- **Not yet ready to promote:** there is no Identity shadow, the crypto/SQL still live in `middleware/`,
  and authorization is still triplicated. Readiness level: **Consolidation-required (pre-shadow).**

## 9. Governance Decision

- The **consolidated Enterprise Identity Kernel is hereby designated the single, authoritative owner**
  of all identity responsibilities. This ownership model is the architectural source of truth for
  every future Identity decision.
- Options A and B are **rejected** as standalone owners; their assets are absorbed by C (A = behavior,
  B = structure).
- Any future Identity work must target the consolidated kernel and must not reintroduce a second
  identity owner. Formal ratification (an ADR) and the migration plan are **separate future phases**;
  they are out of scope here by constraint.

## 10. Final Recommendation

Adopt **Option C**. Establish the consolidated Enterprise Identity Kernel as the permanent single
owner per the Responsibility Matrix (§5) and Target Architecture (§6). Do **not** begin implementation
on this decision: the next phases should, in order, (1) ratify this model in an ADR, (2) consolidate
the domains and relocate the primitives behind the single Identity port, (3) stand up an Identity
shadow to prove 100% parity, then (4) run the Config-style flag-gated authoritative promotion. This
phase closes all ambiguity about *who owns identity*: the one consolidated Identity Kernel — nothing
else.
