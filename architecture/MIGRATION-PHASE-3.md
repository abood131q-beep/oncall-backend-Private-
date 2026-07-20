# Enterprise Architecture Migration — Phase 3 Record (Users Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0, ADR-002/003/004/005/007/015
**Status:** Cutover implemented and A/B-proven in this environment · **Date:** 2026-07-16

---

## 1. Migration Summary

The **Users bounded context** is migrated into the ADR-005 layered architecture
beside the legacy implementation, using the same Strangler recipe proven in Phase 2
(Identity). The new router is the default; the legacy router remains the instant,
byte-identical rollback target via `USERS_LEGACY=1` until Phase 4.

**Scope decision (evidence-driven).** The mission lists ten conceptual Users
operations, but the legacy `src/routes/users.js` implements only **seven endpoints**.
Under the Phase-3 constraints ("never introduce breaking changes / no new features"),
only existing behavior may be migrated. Therefore:

- **Migrated & wired (7 endpoints):** Update Profile (`POST /user/update`), User Balance
  Read-Only (`GET /balance/:phone`), deprecated balance-add 410 (`POST /balance/add`),
  User Activity Read-Only (`GET /transactions/:phone`), Notifications list
  (`GET /notifications/:phone`), Notifications mark-read (`PUT /notifications/:phone/read`),
  User Reports (`POST /report`).
- **Domain-modeled, not wired (no legacy endpoint exists → wiring would be a new
  feature):** Get User Profile, User Preferences, Language/Locale, user-facing User
  Status, User Settings. The **Locale Value Object** and **User Preferences Policy**
  are created per the Phase-3 Domain Requirements as the vocabulary the aggregate will
  adopt in Phase 4 (they also require an ADR-004 schema column and a new endpoint —
  both out of scope now). Zero behavior change.

Wallet **write** logic (charge/deduct/transaction mutation), Payments, and Trips are
untouched — separate contexts, explicitly out of scope. Balance/Activity are exposed
only as **read-only projections** through a Read Model Adapter, so no Wallet logic
crosses into Users.

---

## 2. Files Created

**Domain (pure — no framework, no SQL, no persistence):**
- `src/domain/users/profileValues.js` — DisplayName Profile VO + Locale VO + defaults
- `src/domain/users/userPolicies.js` — UserStatusPolicy (balance read-authorization) + UserPreferencesPolicy (report-type normalization)
- `src/domain/users/User.js` — User Aggregate (rehydrate, rename, status, locale)

**Application (orchestration; contracts; no transport/SQL/vendor):**
- `src/application/users/ports.js` — port contracts + `assertPorts` (fail-fast)
- `src/application/users/commands.js` — command factories + input validation
- `src/application/users/useCases.js` — 6 use cases (typed results)
- `src/application/users/index.js` — composition entry point

**Infrastructure (contract implementations; SQL delegation only):**
- `src/infrastructure/repositories/userRepositoryAdapter.js` — Update Profile + Reports
- `src/infrastructure/repositories/userReadModelAdapter.js` — Balance + Activity read projections
- `src/infrastructure/notifications/notificationPreferenceAdapter.js` — notifications list + mark-read

**Presentation (HTTP translation only; zero business logic):**
- `src/presentation/api/usersController.js` — result→contract mapping (frozen)
- `src/presentation/api/usersRoutes.js` — router + composition root

**Verification & tests:**
- `tests/unit/users.test.js` — 13 domain + use-case tests (pure fakes)
- `tests/integration/users-ab.mjs` — live A/B compatibility harness (17 scenarios)

---

## 3. Files Modified

| File | Change |
|---|---|
| `server.js` | one guarded cutover block (11 lines): new Users router is default; `USERS_LEGACY=1` restores the legacy router. Mirrors the Phase-2 Identity block exactly. Only edit to legacy runtime code. |

_(The two test files were auto-formatted by Prettier after creation — no logic change.)_

---

## 4. Files Mounted (carrying traffic)

`src/presentation/api/usersRoutes.js` → `usersController.js`
→ `src/application/users/*` → `src/domain/users/*`
→ port contracts → `src/infrastructure/{repositories,notifications}/*` adapters
→ existing certified repositories (`userRepo`, `walletRepo` reads, `notifRepo`, `reportRepo`).
All 7 scoped endpoints flow Presentation → Application → Domain → Repository Contracts →
Infrastructure, with no layer skipped.

---

## 5. Legacy Files Remaining

`src/routes/users.js` — **preserved verbatim, unmounted by default.** It is a
*provably identical* rollback target: the A/B harness executes it as the "legacy" arm.
Dead code pending Phase-4 retirement (after a production soak), not a business-logic
holder. All other legacy routes/services untouched.

---

## 6. Compatibility Proof (executed, this environment)

Live A/B harness: the **real server booted twice** — legacy arm (`USERS_LEGACY=1`) and
new arm — on fresh databases via the `node:sqlite` compat preload; an identical
17-scenario suite driven through both; responses normalized only for nondeterminism
(tokens, datetimes, ids) and compared **order-sensitively (JSON key order included)**.

**Result: 17/17 byte-identical**, covering: profile update (happy / no-name / no-auth
401), balance (self 200 / **IDOR other-phone 403** / no-auth 401), deprecated
balance-add 410, transactions (self / other-path-still-own / no-auth 401), notifications
(list / other-path-still-own / mark-read / no-auth 401), and reports (typed / defaulted
type+trip_id / no-auth 401). The deliberate legacy **asymmetry** — `/balance` enforces
the IDOR 403 while `/transactions` and `/notifications` ignore the path phone — is
reproduced exactly.

**Regression:** the Phase-2 Identity A/B harness re-run after the `server.js` edit —
**35/35 still identical** (no collateral impact).

---

## 7. Architecture Compliance (mechanically verified)

A require-graph analyzer (`/tmp/compliance.mjs`, comment-stripped) over the 12
enterprise-layer files reports **all rules PASS**:

- ✔ No framework import (`express`/socket.io) in Domain or Application.
- ✔ No SQL text outside Infrastructure (Domain/Application/Presentation clean).
- ✔ Presentation controller imports **no Domain, no Database, no Infrastructure**
  (only Application) — zero business decisions; every outcome is a typed result.
- ✔ Domain imports nothing above it (pure).
- ✔ Application depends only downward (no Infrastructure/Presentation imports).
- ✔ **No circular dependencies** (DFS over the require-graph of all 12 files).

Composition root note: `usersRoutes.js` (Presentation) legitimately wires Infrastructure
adapters — the accepted composition-root pattern established in Phase 2; the request
handler (`usersController.js`) stays pure.

---

## 8. Security Compliance

| Item | Evidence |
|---|---|
| Authentication | `authenticate` middleware preserved on all 7 routes, same order; A/B: every no-token case → 401 identical |
| IDOR — balance | Authorization policy in Domain (`balanceReadAuthorization`); A/B: other-phone → **403 identical**; unit-tested |
| IDOR — transactions/notifications | Legacy JWT-only-identity preserved (path phone ignored); A/B: other-path returns the actor's own data identically |
| Mass assignment | actor phone always from the session (`req.user.phone`), never the body/param — matches legacy; enforced in commands |
| Deprecated surface | `POST /balance/add` → 410 with identical `code:'ENDPOINT_DEPRECATED'` body |
| No new attack surface | zero new endpoints; no new SQL; read-only projections cannot mutate Wallet |
| Data minimization | balance use case returns only `{ balance }`; no over-fetch introduced |

No security-relevant behavior changed. The migration is behavior-preserving by proof.

---

## 9. Test Results

- **Unit: 85/85 pass** (55 repositories + 17 identity + **13 new users**) — coverage
  increased from 72; none removed or weakened.
- **A/B compatibility (integration + regression + legacy-compat in one instrument):**
  Users **17/17 identical**; Identity **35/35 identical** (regression).
- **Security:** IDOR / no-auth / privilege boundaries exercised by both the A/B suite
  and unit tests.
- **Lint:** clean, 0 warnings (whole tree). **Format:** clean (whole tree).
- **Architecture compliance:** all rules pass (mechanical).

Legacy `run_tests.sh` external-CLI DB steps remain unrunnable here (no `sqlite3` CLI —
environment limitation, declared); their Users coverage is superseded by the A/B
harness, which compares against the legacy implementation itself.

---

## 10. Rollback Procedure

`USERS_LEGACY=1` in the environment + restart → the legacy `src/routes/users.js` serves
all Users traffic. **The rollback path is itself live-proven** (the harness's legacy arm
is exactly rollback mode). No data migration in either direction — both routers read and
write the same tables through the same repositories. Full code rollback if ever desired:
revert the one `server.js` block.

---

## 11. Remaining Technical Debt

1. `src/routes/users.js` dead code — retire in a later phase after a production soak.
2. Arabic messages live in the controller — extract to ADR-003 catalogs when the
   Localization context lands (same debt noted in Phase 2).
3. **Locale VO / Preferences Policy are modeled but unwired** — they need an ADR-004
   `users.locale`/preferences column and new endpoints before exposure (Phase 4).
4. `DisplayName` VO mirrors legacy leniency (accepts any value incl. undefined) — tighten
   at legacy retirement under an ADR amendment, not before (byte-fidelity).
5. Balance/Activity read the `users.balance`/`transactions` tables via the Wallet
   repository; when the Wallet context is formalized, the Read Model Adapter should point
   at a Wallet-owned read model instead of the shared repository.
6. Standing platform debt, unchanged: the concurrency/transaction issue (ADR-001,
   undecided) and the in-memory rate-limit multi-instance limitation — neither touched by
   this phase.

---

## 12. Readiness Assessment for Phase 4

**Users: ADR-compliant bounded context by evidence** — layered per ADR-005, byte-compatible
by live proof (17/17), security semantics preserved, instant proven rollback, increased
test coverage (85/85), mechanical compliance clean, and no Phase-2 regression (35/35).

Recommended before Phase 4: commit this state as a baseline (surgical diffs), and one
production soak window watching the Users endpoints. The proven recipe now covers Identity
and Users; the next context by the same discipline is **Drivers** (highest value) or the
Notifications context. **Wallet/Payments remain last, gated on the ADR-001 decision** —
this phase deliberately kept Balance/Activity as read-only projections precisely so that
gate is not pre-empted. **Phase 4 not started, per instruction.**

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed
test or a mechanical check; environment limitations (native `sqlite3`/`sqlite3 CLI`,
Flutter SDK) are declared where they apply. No legacy behavior was changed; no new feature
was added.*
