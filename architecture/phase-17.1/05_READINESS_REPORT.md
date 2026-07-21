# Phase 17.1 — Integration Readiness Report (STEP 6)

**Question this report answers:** *Is the current OnCall backend ready to begin migration
onto the Enterprise Platform?*

---

## Verdict: ✅ CONDITIONALLY READY

The backend is **ready to begin the additive, wrap-and-observe integration** described in the
Roadmap (sub-phases 17.1.0 → 17.1.7). It is **not yet ready** for any kernel to *own*
persistent or auth-critical behavior; those steps are correctly deferred and gated on the two
blockers below.

Rationale in one line: the Platform is strictly additive, the app has a proven reversible
cutover mechanism, and no in-scope 17.1 step changes external behavior — so integration can
start immediately at zero client risk, while the risky "ownership" steps are fenced off
behind explicit blockers.

---

## Readiness Scorecard

| Dimension | State | Ready? | Evidence |
|---|---|---|---|
| **Platform composes & verifies standalone** | `createPlatform().verify()` passes; 25-kernel catalog with deterministic ordering | ✅ | `src/platform/platformBuilder.js`, `tests/unit/*` (host, deployment, gateway, etc.) |
| **Platform is additive** | "importing wires nothing until `createPlatform()`" | ✅ | `src/platform/index.js` header contract |
| **App boot is well-defined & wrappable** | ordered IIFE, single `services` DI object, clear start/stop | ✅ | `server.js` (steps 2–9 + shutdown) |
| **Reversible cutover mechanism exists** | per-context `*_LEGACY` flags already in production | ✅ | `server.js` lines 194–310 |
| **Byte-compat test harness exists** | A/B harness per context + integration suite | ✅ | `tests/integration/*-ab.mjs`, `npm run test:ab`, `integration-test.mjs` |
| **Lifecycle/Host/Runtime/Deployment present** | ADR-043/044/045 layers built | ✅ | `src/runtime`, `src/host`, `src/deployment` |
| **DB-backed kernel providers** | none — all memory/file/env/json | ❌ | providers scan: every kernel ships `memoryProvider.js` only |
| **Identity provider proving token parity** | not present | ❌ | `src/application/identity-kernel/providers/` = memory only |
| **App currently wired to Platform** | not wired (greenfield) | ⚠️ (expected) | grep of `server.js`/routes for platform/runtime/host = empty |

Two ❌ rows are the blockers; the ⚠️ row is the expected starting condition, not a defect.

---

## Blockers (must clear before the corresponding *ownership* step — NOT before 17.1 starts)

### B1 — No byte-compatible DB-backed Storage/state provider
**What:** Every kernel provides only in-memory (or file/env/json) persistence. Storage,
Ratelimit, Notifications, Jobs, Identity have no provider that reads/writes the **existing**
SQLite/PG tables with identical semantics (WAL, FK enforcement, `SQLITE_BUSY` JS-retry,
dual-dialect via `DB_ENGINE`).
**Blocks:** any "Own" posture — Storage owning the DB, Ratelimit owning `rate_limit_locks`,
Notifications owning `notifications`/`device_tokens`, Jobs owning durable job state.
**Does NOT block:** 17.1.0–17.1.7 (all wrap/observe/shadow).
**Clearance criterion:** a DB-backed provider passes the A/B harness against the current
tables with zero divergence, including transaction/retry/PRAGMA behavior.

### B2 — No proven auth-token parity for the Identity kernel
**What:** Live Flutter clients hold JWTs and refresh tokens minted by
`src/middleware/auth.js`. The Identity kernel has only a memory provider and no proof that it
issues/verifies tokens with identical structure, claims, `exp`, secret handling, refresh
rotation, and revocation propagation.
**Blocks:** Identity owning token issue/verify/refresh/revocation.
**Does NOT block:** Identity shadow (17.1.6) or the rest of 17.1.
**Clearance criterion:** shadow Identity produces byte-identical tokens/claims and identical
verify/revocation decisions across a full A/B run, including cross-replica revocation timing.

---

## Non-blocking gaps / cautions
- **Flag governance:** new `PLATFORM_*` / `SHADOW_*` flags must be documented in
  `.env.example` with defaults that reproduce baseline; CI (`npm run ci`) should assert this.
- **Single-tenant reality:** Tenancy kernel (ADR-038) has no app mapping; compose-only.
- **Gateway placement:** must stay out of the request path in 17.1 (route/response risk).
- **Job duplication:** enforce exactly-one-scheduler when 17.1.5 lands.
- **Observability parity:** `/metrics` + health bodies must remain byte-identical when fed
  from the kernel (17.1.4).

---

## Readiness Conditions to START (all met)
1. Platform verifies standalone. ✅
2. A/B harness + golden baseline capturable. ✅ (17.1.0)
3. Every new coupling is flag-guarded, default-OFF. ✅ (design)
4. No route/schema/token/socket change in any 17.1 sub-phase. ✅ (design)
5. Rollback = flag flip, no code change. ✅ (design)

## Readiness Conditions to reach "OWNERSHIP" (not yet met)
6. B1 cleared (DB-backed provider parity). ❌
7. B2 cleared (Identity token parity). ❌
8. Shadow divergence dashboards show zero drift over a soak period. ⏳ (produced by 17.1.6)

---

## Recommendation
**Proceed with Phase 17.1 integration now**, beginning with 17.1.0 (baseline) → 17.1.1
(compose-but-don't-consume) → 17.1.3 (app-as-hosted-service / Lifecycle ownership), which
delivers the core objective — *the OnCall backend running on top of the Enterprise Platform* —
with zero external behavior change and instant rollback. Sequence Config mirror (17.1.2),
Observability feed (17.1.4), and Jobs/Scheduler (17.1.5) next. Keep all ownership work
**out of Phase 17.1** until blockers B1 and B2 are cleared and evidenced by the A/B harness.

**Do not** migrate any code, modify any backend file, or generate code in this phase — this
report and its companion documents complete the analysis-and-planning mandate.
