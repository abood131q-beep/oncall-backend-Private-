# ADR-047 — Kernel Ownership Preconditions (Shadow → Authoritative Gates)

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Principal Engineering
- **Related:** ADR-046 (Enterprise Shadow Integration), G1.0 §10 (Promotion Rules), Phase 17.1
  Readiness Report (blockers B1/B2), Project Gap Report item **E3**

---

## Context

Every kernel integrated so far (Configuration, Observability, Jobs, Scheduler) is in **Shadow
Mode / Verified** — non-authoritative, with the legacy platform owning all behavior and data.
G1.0 §10 defines a promotion ladder ending in **Authoritative** (the kernel becomes the source
of truth), but the two preconditions that block promotion — first identified in the Phase 17.1
Readiness Report — have never been formally **owned and gated**. The Project Gap Report flagged
this as open engineering debt (E3).

Building those preconditions is out of scope for a stabilization phase (and is explicitly a
"no new features / no new kernel" boundary). The correct remediation is therefore to **accept
the blockers as governed, enforced gates**: record them, define their exit criteria, and make
them a hard precondition on any promotion past *Verified*.

## Decision

No Enterprise kernel may be promoted **past the `Verified` state toward `Authoritative`** until
its applicable precondition below is cleared, evidenced, and signed off by the Standard Owner
(G1.0 §13). These gates are architectural invariants under ADR-046.

### Gate B1 — Byte-compatible DB-backed provider
**Applies to:** any kernel that would own **persistent state** (Storage, Rate Limiting,
Notifications, Jobs durable state, Identity refresh/revocation).
**Problem:** every kernel currently ships only in-memory / file / env providers; none reads or
writes the existing SQLite/PG tables with identical semantics.
**Exit criteria (all required):**
1. A DB-backed provider reads/writes the **existing** tables (no schema change) with identical
   results — including WAL, FK enforcement, `SQLITE_BUSY` JS-retry, and dual-dialect via
   `DB_ENGINE`.
2. It passes the kernel's A/B harness against the current tables with **zero** divergence,
   including transaction/retry/PRAGMA behavior.
3. Rollback to the legacy store is flag-only and data-lossless.

### Gate B2 — Proven Identity token parity
**Applies to:** the Identity kernel owning **authentication** (issue/verify/refresh/revocation).
**Problem:** live Flutter clients hold JWTs/refresh tokens minted by
`src/middleware/auth.js`; there is no proof the kernel produces byte-identical tokens/claims.
**Exit criteria (all required):**
1. Shadow Identity produces **byte-identical** tokens/claims (structure, `exp`, secret handling)
   and identical verify/revocation decisions across a full A/B run.
2. Cross-replica revocation timing matches the current Redis-backed behavior.
3. A staged rollback restores `middleware/auth.js` as authoritative with no client re-auth.

## Enforcement

- **Promotion is blocked at `Verified`.** Advancing any kernel to *Candidate Ownership* or
  *Authoritative* requires its own promotion ADR that **cites this ADR** and attaches the exit
  evidence.
- The gates are tracked here (single source of truth) and referenced from the Phase 17.1
  Readiness Report and the Project Gap Report (E3 → *Accepted & Gated*).
- CI already enforces the shadow guarantees (parity via `verify:shadow`, byte-identity via
  `test:ab`, architecture-compliance gate); these gates add the **ownership** precondition on
  top, checked at promotion time by review, not by CI.

## Consequences

**Positive**
- The blockers move from "unaddressed" to **explicitly owned, defined, and enforced** — no
  kernel can silently become authoritative and risk data/auth regressions.
- Gives a concrete, testable definition of "done" for future migration work.

**Negative / accepted**
- Functional migration remains deferred until the gates are cleared (by design for a
  shadow-only programme). Shadow phases continue to deliver verification value, not ownership.
