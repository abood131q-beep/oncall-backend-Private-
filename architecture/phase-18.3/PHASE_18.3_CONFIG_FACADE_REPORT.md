# Phase 18.3 — Runtime Configuration Read Facade — Execution Report

**Mission:** Build the runtime configuration read seam identified as the missing prerequisite in the
Phase 18.2 blocking report, so that the Configuration kernel can *later* be promoted to authoritative
(ADR-048) **without any further consumer refactoring** — while changing **zero** production behavior
now and keeping the Configuration kernel **NON-authoritative** in this phase.

**Result:** ✅ **Delivered.** The facade `src/config/index.js` (`config.get` / `config.require` /
`config.has` / `config.keys` / `config.all`) is in place, behavior-identical to `env.js`, three
representative consumers are migrated and verified, and the invariant is **mechanically enforced** by a
new architecture-gate rule (**R8**) with a shrink-only ratchet. All runnable gates are green; no
production behavior changed.

**Local verification:** ESLint **PASS** · Architecture gate **PASS (R1–R8, 0 violations)** ·
`verify:shadow` **PASS** (4 shadows 100% parity + coverage) · unit regression **870/870** (enterprise +
shadow + host) · facade unit test **7/7**. DB-backed + A/B + Postgres suites run in CI (sqlite native
binding unavailable in this cross-arch sandbox).

---

## 1. Did a better architecture than the facade exist? (evidence-based, evaluated before building)

The mission required: *"If a better architectural approach exists than the proposed facade, explain it
with evidence before implementation."* Four candidates were considered:

| Approach | What it is | Verdict | Evidence / reason |
|---|---|---|---|
| **A. Runtime read facade** (chosen) | One sync module `config.get(key)` backed by `env.js`; consumers migrate to it; ADR-048 later re-points the backing to the kernel snapshot in **one place**. | ✅ **Selected** | Only option that creates a *single re-pointable seam* while staying synchronous and behavior-identical. Consumers change **once**; ADR-048 changes **zero** consumers. |
| **B. Re-export env values from the facade** (consumers `require('../config')` but keep destructuring) | Facade re-exports the same `{...}` shape; migration = change the import path only. | ❌ Rejected | Values are still captured at **import time**, so there is still nothing a runtime kernel can back — it does **not** solve the 18.2 blocker (the whole reason for this phase). Cosmetic. |
| **C. Async config provider / `await` the kernel in `env.js`** | Make config acquisition async; seed from the kernel at boot. | ❌ Rejected | `env.js` is loaded synchronously at `server.js:24` **before** the platform boots; you cannot `await` the async kernel snapshot there, and it introduces a `env.js → platform → kernels → env.js` cycle. Same invalid Option B from the 18.2 report. |
| **D. Global mutable config singleton** | A module holding a mutable object that boot code overwrites. | ❌ Rejected | Reintroduces load-order coupling and non-determinism (readers see different values depending on when they read), and defeats fail-fast. Strictly worse than a pure function over a static source. |

**Conclusion:** the facade (A) is the correct minimal design. The key architectural insight — and why A
is *sufficient* for ADR-048 even though much config is consumed at module-load time — is that
**centralizing every read into one module makes the backing swappable in one place.** ADR-048 does not
need to intercept each consumer at runtime; it only needs to change what `config.get` reads *inside the
facade* (env → kernel-validated snapshot, env fallback). That is a single-file change, which is exactly
the property 18.2 found missing.

## 2. The facade (`src/config/index.js`)

Contract (synchronous, deterministic, no async boot dependency, typed values preserved):

```
config.get(key[, fallback])  → typed value, or fallback (default undefined) if absent
config.require(key)          → typed value, or THROW if absent  (explicit required-key fail-fast)
config.has(key)              → boolean presence
config.keys()                → all defined keys
config.all()                 → shallow copy (debug/bulk; not the hot seam)
config._source               → 'env.js'  (ADR-048 will flip to 'kernel')
```

Backed by `require('./env')`. Because it returns `env[key]` by reference-identity, values are the
**exact** typed objects `env.js` computes (numbers, booleans, arrays, parsed Firebase JSON) — proven by
`tests/unit/configFacade.test.js` (7/7), which asserts `config.get(k) === env[k]` for **every** key,
type-equality for every key, fallback semantics, `require()` throw-on-missing, and `keys()/has()`
surface equality. `env.js` remains the seed **and** the current source of truth; its load-time
fail-fast (missing `JWT_SECRET` → exit) is preserved untouched (the facade `require`s `env.js`, so that
fail-fast still fires first).

**Forward (NOT this phase):** ADR-048 changes only the *backing* of `get/has/keys` to the Configuration
kernel's validated snapshot when `CONFIG_AUTHORITATIVE=1`, with `env.js` as the mandatory fallback.
Consumers do not change again.

## 3. Consumer migration (incremental — 3 of 12 this phase, each behavior-identical)

Migrated (representative across middleware + service layers; low blast-radius, each a pure
value-substitution with no format/response impact):

| File | Layer | Before | After |
|---|---|---|---|
| `src/middleware/setup.js` | middleware (CORS) | `const { ALLOWED_ORIGINS } = require('../config/env')` | `config.get('ALLOWED_ORIGINS')` |
| `src/services/otpService.js` | service | `const { SMS_PROVIDER } = require('../config/env')` (2 uses) | `config.get('SMS_PROVIDER')` |
| `src/services/places.js` | service | `const { GOOGLE_MAPS_API_KEY } = require('../config/env')` (2 uses) | `config.get('GOOGLE_MAPS_API_KEY')` |

**Why identical behavior:** `env.js` computes each value **once** and freezes it into a static export;
`config.get(k)` returns that same value by reference. There is no code path where `config.get(k)` can
differ from the previously-destructured `k`. HTTP responses, CORS origins, OTP provider selection, and
Places behavior are therefore byte-identical — additionally guarded by the CI `ab-compat` A/B harness
(byte-identical HTTP) and `verify:shadow` (config parity 100%).

**Deliberately deferred** (incremental discipline; each will migrate in its own small, A/B-verified
step): the 9 remaining app consumers in §5, including the **security-critical** `auth.js` (JWT/admin)
and the routers — migrated last, individually, to keep each change trivially reviewable and reversible.

## 4. Invariant enforcement — the R8 ratchet (mechanical, not just documented)

Added **R8 — config-read-seam** to `architecture/compliance/verify-architecture.mjs` (the existing
executable governance authority, already CI-gating). It scans **all of `src/` + `server.js`** (the
prior R1–R7 only walked the four enterprise layers, so this widens coverage to middleware/services/app)
and flags any module that imports `config/env` directly, **except**:

- **EXEMPT** (read `env.js` by design, permanently): `src/config/env.js` (the source), `src/config/index.js`
  (the facade — the one approved backing point), `src/platform-adapters/configuration/legacySource.js`
  (the Configuration shadow's authoritative legacy source).
- **LEGACY_ALLOWLIST** (permitted *for now*, **shrink-only**): the 9 unmigrated consumers + `server.js`.

**Any NEW file** reading `config/env` directly is **not** on the allowlist → **R8 MAJOR violation** →
CI fails (the CI summary gate counts `[MAJOR]`). Proven both ways this phase: gate **PASS** with the
current allowlist; a synthetic new `config/env` importer was **correctly flagged FAIL**. As each legacy
consumer migrates, its entry is removed from the allowlist; when the allowlist is empty the invariant is
absolute. This is the standard "ratchet" pattern — the invariant can only get stronger, never weaker.

## 5. Remaining direct `env.js` consumers (9 app modules + exemptions)

**To migrate (shrink the R8 allowlist as each is done):**

```
src/middleware/auth.js               JWT_SECRET, ADMIN_PHONES        (security-critical — migrate last, alone)
src/app/onCallApplication.js         ADMIN_PHONES, PORT, SOCKET_CORS_ORIGIN  (+ identity-router env at L234)
src/presentation/api/adminRoutes.js  NODE_ENV, PORT, TZ
src/presentation/api/commerceRoutes.js  PAYMENT_ENABLED
src/routes/auth.js                   REQUIRE_OTP, SMS_PROVIDER
src/routes/payment.js                PAYMENT_ENABLED
src/routes/admin.js                  NODE_ENV, PORT, TZ
src/services/smsService.js           SMS_PROVIDER, SMS_API_KEY, SMS_FROM, SMS_ACCOUNT_SID
src/services/notificationService.js  (Firebase/env block)
```

**Exempt (stay direct by design):** `src/config/env.js`, `src/config/index.js`,
`src/platform-adapters/configuration/legacySource.js`. `server.js:24` is a bootstrap side-effect import
(fail-fast trigger) — currently allowlisted; it can migrate to `require('./src/config')` trivially since
the facade re-triggers env's fail-fast.

## 6. Architecture impact

- **Layering:** the facade lives in `src/config/`, depends only on `env.js` (no cycle; arch gate R6
  PASS). No kernel, framework, SQL, or platform coupling introduced (R1/R2 PASS).
- **New governance rule R8** widens the compliance gate's coverage to the whole `src/` tree for the
  config-seam invariant — a permanent, executable guardrail.
- **No runtime/boot-order change:** `env.js` still loads first at `server.js:24`; the facade is a pure
  synchronous function over it. Both boot modes (legacy / enterprise) unaffected.

## 7. Regression report

| Gate | Where | Result |
|---|---|---|
| ESLint (`--max-warnings 0`) | here | ✅ PASS (facade + 3 migrated files) |
| Architecture compliance (R1–R8) | here | ✅ PASS (0 violations) |
| R8 ratchet negative test (synthetic new consumer) | here | ✅ Correctly FAILED (proves enforcement) |
| `verify:shadow` (4 shadows) | here | ✅ PASS — parity 100%, coverage 100%, 0 mismatches; inert when flags OFF |
| Facade unit test (`configFacade.test.js`) | here | ✅ 7/7 (value/type identity, fallback, fail-fast, surface) |
| Unit regression (enterprise + shadow + host) | here | ✅ 870/870 |
| Repository/DB-backed unit + integration + `ab-compat` A/B | CI (sqlite) | ⏳ runs in CI |
| PostgreSQL cross-engine A/B | CI (Docker) | ⏳ runs in CI |

No item regressed. Public APIs, JWT/token format, DB schema, routing, and Flutter contracts unchanged.

## 8. Promotion readiness assessment (ADR-048)

The 18.2 blocker is **resolved**: a single runtime config-read seam now exists. ADR-048 becomes
technically achievable **without further consumer refactoring** — its remaining work is:

1. **Complete the migration** (shrink R8 allowlist to empty) so *all* reads flow through the facade.
   Until then, unmigrated consumers still bind `env.js` at import and would not observe a kernel
   backing — so the promotion is only *fully* meaningful once the allowlist is empty. (Partial
   promotion is possible but would be split-brain; recommend finishing migration first.)
2. **Re-point the facade backing** inside `src/config/index.js` only: when `CONFIG_AUTHORITATIVE=1`,
   `get/has/keys` read the Configuration kernel's **synchronously-available validated snapshot** (seed
   the snapshot from defaults at facade load), with **mandatory `env.js` fallback** on any miss/error.
   No consumer changes.
3. **A/B + soak:** the `config-authoritative-ab.mjs` harness (`CONFIG_AUTHORITATIVE=0` vs `=1`,
   byte-identical HTTP) + zero-drift soak, per P1-5 §4.
4. **ADR-048** citing ADR-046/047 with attached evidence; flip the flag with instant rollback.

**Config kernel remains NON-authoritative in this phase** — no `CONFIG_AUTHORITATIVE` flag, no
authoritative read path, no ADR-048 written here. This phase built *only* the seam.

## 9. What was and was not done

- **Done:** facade + unit test; 3 consumers migrated (A/B-safe, value-identical); R8 ratchet enforcement
  (proven both directions); full local verification; this report.
- **Not done (by design):** no `CONFIG_AUTHORITATIVE`, no authoritative wiring, no ADR-048, no kernel
  promotion; the other 9 consumers left for subsequent incremental steps (allowlisted, not forgotten).

## 10. Sandbox note (host action needed)

The R8 negative test created a probe file that the sandbox FUSE mount would not let me delete
(`Operation not permitted`, same class of limitation as the `.git/index.lock` issue). It is neutralized
(inert, no `config/env` import, gate-clean) but should be removed host-side:
`git clean -f src/services/__ratchet_probe.js` (or delete the file). Likewise, all changes here still
need to be committed on the host (git commit is not possible from this sandbox).

## 11. Recommendation

Merge Phase 18.3. Then proceed incrementally: migrate the 9 remaining consumers one module per PR
(each `ab-compat`-verified, R8 allowlist shrinking), finishing with `auth.js` and the routers. Once the
allowlist is empty, execute the ADR-048 promotion exactly as designed in P1-5 §2 / §8 — a real, safe,
reversible first authoritative promotion.
