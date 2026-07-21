# Phase 20 — Identity Kernel Full Consolidation — **BLOCKING REPORT**

**Decision:** 🚫 **STOP. The full authoritative migration + legacy removal is NOT executed this
phase.** `src/middleware/auth.js` and the legacy identity path remain **authoritative and
unchanged**. No responsibility was cut over; nothing was removed. The Phase 19.4 skeleton is left
intact and green. **No code was changed in this phase.**

**Why:** the phase's own governing ADRs (ADR-046/047/048/049), which it commands must not be
contradicted, **forbid** an authoritative identity cutover + legacy removal without a Shadow → A/B →
Flag → Production Soak → Owner sign-off sequence — and **none of that verification can even be
executed or observed in this environment.** Completing the cutover here would be unverified removal
of the certified authentication core protecting live Flutter sessions. Per the programme's standing
rule — *engineering correctness over completion; never work around a failure* — this is a STOP.

---

## 1. The mission contains a self-contradiction; ADR-conformance wins

- The mission orders: make the kernel the **ONLY** owner, route **every** request through the
  Identity Port, and **remove** `middleware/auth.js` / legacy ownership **this phase**.
- The mission also orders: *"No architectural decisions may contradict ADR-046/047/048/049."*

These two orders are mutually exclusive:

- **ADR-049 §7** (the Identity migration strategy this phase implements) defines the mandatory
  order: `Consolidation → Identity Port → Shadow → A/B → Flag → Production Soak → Authoritative
  Promotion`. Authoritative cutover is the **last** step, behind a flag, after a soak.
- **ADR-047 Gate B2 — Proven Identity token parity** (verbatim, `ADR-047:44-52`): promotion of the
  Identity kernel to authoritative is **blocked at `Verified`** until, *all required*: (1) Shadow
  Identity produces **byte-identical** tokens/claims and identical verify/revocation decisions
  across a **full A/B run**; (2) cross-replica revocation timing matches the Redis-backed behavior;
  (3) a staged rollback restores `middleware/auth.js` with no client re-auth. It further requires a
  **promotion ADR that cites ADR-047 and attaches the exit evidence.**
- **ADR-046** requires Shadow Mode (legacy authoritative) until an evidenced promotion.
- **ADR-048 / Milestone M1** is the reference methodology: flag (default OFF) → A/B byte-identical →
  zero-drift **production soak** → promotion ADR → then authoritative.

Removing `middleware/auth.js` and making the kernel the sole owner **this phase** contradicts every
one of these. Since the mission forbids contradicting them, **the ADRs govern and the cutover is
blocked.**

## 2. Verification is impossible in this environment (objective)

The mission's per-responsibility method requires, before continuing to the next responsibility:
*(5) verify byte-identical behavior, (6) shadow verification, (7) A/B verification, (8) regression,
(9) API, (10) Flutter, (11) Socket, (12) Security* — and *"Never migrate the next before 100%
parity."*

Objective facts in this environment:

| Capability needed | Available here? | Evidence |
|---|---|---|
| Boot the server (auth/HTTP) | ❌ | `require('sqlite3')` → `ERR_DLOPEN_FAILED` (cross-arch native binding) |
| Run HTTP A/B (`*-ab.mjs`) | ❌ | needs a live server + sqlite |
| Run socket authentication tests | ❌ | needs a live server |
| Run DB-backed refresh/revocation/login-log parity | ❌ | needs sqlite |
| Run security/integration suites | ❌ | CI-only (sqlite/Docker) |
| Identity shadow (byte-identical token parity) | ❌ **does not exist** | `src/enterprise/` has config/observability/jobs/scheduler shadows only — **no identity shadow** |

Therefore **step 5–12 cannot be executed or observed for even the first responsibility.** Per the
mission's own gate ("never proceed before 100% parity"), the migration is **blocked at
responsibility #1, step 5** — parity cannot be certified, so no cutover may proceed. Fabricating a
"100% parity / A/B passed" claim without running them would violate the programme's core discipline
and 18.6's precedent.

## 3. This is the highest-blast-radius change in the system

`middleware/auth.js` is the **certified** security core: HS256 JWT issue/verify (timing-safe),
refresh-token issuance/verification (SQL), and the revocation store (SQL + in-memory + Redis
fan-out). Live Flutter clients hold tokens minted by it. The mission itself requires *"JWT payload
identical, JWT signature behavior identical, Refresh Tokens identical, Socket authentication
identical, existing clients continue working."* Those guarantees are **exactly** what a shadow +
A/B + soak exist to prove — and they are unprovable here. Removing or bypassing this core unverified
directly risks mass client re-auth / lockout, violating the production requirements it lists.

## 4. Responsibility Migration Matrix (analysis — the plan, since execution is blocked)

Every responsibility mapped to its consolidation, with **where** it can be verified. "CI/prod" = not
verifiable in this sandbox. All targets are the ADR-049 owners; the 19.4 skeleton already provides
the ports/adapters to receive them.

| Responsibility | Current owner (authoritative) | Target (kernel) | Method | Verifiable here? |
|---|---|---|---|---|
| JWT sign/verify | `middleware/auth.js` | `infrastructure/identity/tokenAdapter` via `tokenPort` | wrap → shadow parity → flag | Partial (pure sign/verify sqlite-free); revocation needs DB → CI |
| Access tokens | `middleware/auth.js` | tokenPort | wrap | Partial |
| Refresh tokens | `middleware/auth.js` (SQL) | tokenPort + sessionStore | wrap | ❌ DB → CI |
| Token revocation | `middleware/auth.js` (SQL+Redis) | tokenPort | wrap | ❌ DB/Redis → CI/prod |
| Token gateway | `gateways/tokenGatewayAdapter` | tokenPort | re-point | ❌ integration → CI |
| OTP | `services/otpService` | `infrastructure/identity/otpAdapter` | wrap | ❌ DB → CI |
| Authentication | `application/identity` useCases | `application/identity/kernel` | move behind port | ❌ HTTP → CI |
| Authorization / Admin resolution | `auth.js` + `loginPolicy` + kernel principal (triplicated) | `domain/identity/kernel/policies` | unify to one locus | Partial (pure) |
| Session management / Device identity | JWT payload + driver presence + socket | `domain/identity/kernel/session` + sessionStore | move | ❌ DB/socket → CI |
| Principal / Claims / Roles / Permissions | `loginPolicy` payloads / kernel | `domain/identity/kernel/principal` | consolidate | Partial (pure) |
| Identity policies | `domain/identity/loginPolicy` | `domain/identity/kernel/policies` | move | Partial (pure) |
| Identity repository | `repositories/identityRepositoryAdapter` | `infrastructure/identity/identityRepository` | wrap | ❌ DB → CI |
| Login / current-principal resolution | `identityController` + useCases | kernel `authenticate`/`resolve` | move behind port | ❌ HTTP → CI |
| Socket authentication | `socket.js` → `verifyJWT` | Identity port | re-point | ❌ socket → CI |
| Identity middleware | `middleware/auth.js` authenticate* | thin edge over Identity port | re-point | ❌ HTTP → CI |
| Identity events/metrics | none / kernel skeleton | kernel `events`/`metrics` | wire | Partial (pure) |
| Provider registration / Identity config / ports / infra / providers | 19.4 skeleton | kernel | already scaffolded | ✅ (inert) |
| Identity logging / auditing / context | `auth.js` logger.security + useCases auditLog | kernel events + audit port | move | Partial/❌ |

**Conclusion of the matrix:** the majority of responsibilities (refresh, revocation, OTP, repo,
sessions, auth flow, socket, middleware) are **DB/HTTP/socket-bound and unverifiable here** — so
their required per-responsibility parity gates cannot be met in this phase.

## 5. What the completion criteria require vs. what exists

| Completion criterion | Status | Blocker |
|---|---|---|
| Kernel is the ONLY owner; legacy removed | ❌ | requires verified cutover (below) |
| Every request flows through the Identity Port | ❌ | no shadow/flag; unverifiable here |
| Shadow passes 100% | ❌ | **no identity shadow exists** |
| A/B passes 100% | ❌ | cannot run (no sqlite/server) |
| Security passes | ❌ | cannot run here |
| Performance within baseline | ❌ | cannot boot to measure |
| Flutter unchanged / API byte-identical | ⚠️ unprovable | needs A/B against live server |
| ADR-047 Gate B2 (token parity) + Owner sign-off | ❌ | no shadow, no A/B evidence, no soak, no sign-off |

Zero of the authoritative-cutover criteria are satisfiable this phase.

## 6. Current state left clean (verified)

- **No code changed** in Phase 20. The Phase 19.4 skeleton is intact and inert.
- Architecture gate **R1–R8 PASS (0 violations)**; `verify:shadow` **PASS** (config/observability/
  jobs/scheduler still 100%); the identity skeleton remains unwired (on no request path).
- `middleware/auth.js`, `services/otpService.js`, the token gateway, and the identity repository
  remain **authoritative** — production behavior is unchanged.

## 7. The correct path (ADR-049 §7 sequence) — multi-phase, and what unblocks each

This is not a single-phase change. The safe, ADR-compliant sequence, each its own governed phase:

1. **20.a — Pass-through wiring (inert):** wire the 19.4 infrastructure adapters to the certified
   legacy primitives (kernel delegates to `auth.js`/`otpService`), non-authoritative, flag default
   OFF. *Unblocks when:* arch/regression green (pure parts verifiable here; DB parts in CI).
2. **20.b — Identity Shadow:** add an Identity shadow (like config/jobs) comparing kernel-vs-legacy
   token verify/issue, admin resolution, OTP-required at **100% parity**. *Unblocks when:*
   `verify-shadow`-style pure parity green here + full A/B green **in CI**.
3. **20.c — A/B + flag:** `IDENTITY_AUTHORITATIVE` (default OFF); HTTP/socket A/B byte-identical in
   CI (ADR-047 Gate B2 evidence #1/#2).
4. **20.d — Production soak + staged rollback proof** (Gate B2 #3) + **promotion ADR-050** citing
   ADR-047 with attached evidence + **Owner sign-off**.
5. **20.e — Authoritative cutover** (flip flag) then **20.f — legacy removal** (convert
   `middleware/auth.js` to a thin adapter, then remove once every path is pass-through and the soak
   is clean).

Legacy removal is **last**, only after the flag has been authoritative through a clean soak — never
before.

## 8. Deliverables status (per the mission)

Produced here (analysis/evidence — the parts achievable without the forbidden cutover): the
responsibility migration matrix (§4), architecture validation (§6, green), the ADR-conflict and
verification-impossibility evidence (§1–§3), and the sequenced path with unblock conditions (§7).
**Not produced (by necessity):** the migration/legacy-removal/shadow/A-B/security/performance/
production-readiness *results*, because the migration was correctly not executed — those artifacts
would be fabrications without a runnable server and the required soak/sign-off.

## 9. Final decision

**BLOCKED — do not perform the authoritative identity migration or remove any legacy identity code
this phase.** It contradicts ADR-046/047/048/049 (which this phase must obey), cannot be verified in
this environment (no sqlite/HTTP/socket; no identity shadow), lacks ADR-047 Gate B2 evidence + Owner
sign-off, and would put live client authentication at unacceptable, unverified risk. Proceed instead
through the ADR-049 §7 sequence (§7 above), one governed phase at a time, keeping `middleware/auth.js`
authoritative until a flag-gated, shadow-proven, soak-verified, Owner-signed promotion. Engineering
governance takes precedence over completing the phase.
