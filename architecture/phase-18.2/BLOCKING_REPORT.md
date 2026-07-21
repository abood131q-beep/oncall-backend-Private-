# Phase 18.2 — Configuration Kernel Authoritative Promotion — **BLOCKING REPORT**

**Decision:** 🚫 **STOP. Promotion NOT executed.** A hidden prerequisite is **not satisfied**.
Per the mission ("If any prerequisite is not satisfied: STOP. Produce a blocking report. Do not
continue" and "Do not work around the failure"), no promotion code was written.

**One-line root cause:** the OnCall application has **no runtime configuration-read seam** — all
consumers capture `env.js` values *synchronously at import time* — so the Configuration Kernel
**cannot become the "primary read source"** without either modifying those consumers (forbidden
this phase) or building an async kernel inside a synchronous early-load module (architecturally
invalid). Any wiring that avoided both would be a **no-op layer** (kernel seeded from env,
returning env's own values) — theater, not a promotion, and a source of technical debt the
mission forbids.

---

## 1. Prerequisite verification (independently checked)

| Prerequisite | Result | Evidence |
|---|---|---|
| ADR-046 (Shadow standard ratified) | ✅ Satisfied | `architecture/ADR/ADR-046-enterprise-shadow-integration.md` (Accepted). |
| ADR-047 (ownership gates) | ✅ Satisfied | `architecture/ADR/ADR-047-kernel-ownership-preconditions.md` (Accepted). |
| G1.0 Promotion Rules | ✅ Satisfied | G1.0 §10 ladder present; Config at *Verified*. |
| P1-5 Config Promotion Readiness | ⚠️ **Partially — contained a latent wrong assumption (corrected below)** | P1-5 assumed "only the config-access facade routes through the adapter." **No such facade exists.** |
| Configuration Shadow implementation | ✅ Satisfied | `src/platform-adapters/configuration/*` present; read-through shadow on shared framework. |
| `verify:shadow` results | ✅ Satisfied | Config parity **100%**, coverage **100%**, 0 mismatches (re-run green). |
| CI status | ✅ Satisfied | `ci.yml` (Node 24) + `verify:shadow` + `ab-compat` + new `postgres` gate. |
| **Runtime config-read seam (implicit prerequisite)** | ❌ **NOT satisfied** | See §2 — this is the blocker. |

Six of seven listed prerequisites hold. The **implicit, load-bearing prerequisite** — a runtime
read seam the kernel can back — does **not** exist, and it is the one that makes an authoritative
promotion possible at all.

## 2. Root cause — evidence

**(a) Consumers read config by import-time destructuring, not through a facade.**
16 modules do `const { X, Y } = require('.../config/env')` — the value is captured **once, at
module load**. Verified consumers include the security- and route-critical paths:

```
src/middleware/auth.js         const { JWT_SECRET, ADMIN_PHONES } = require('../config/env');
src/middleware/setup.js        const { ALLOWED_ORIGINS } = require('../config/env');
src/app/onCallApplication.js   const { ADMIN_PHONES, PORT, SOCKET_CORS_ORIGIN } = require('../config/env');
src/presentation/api/adminRoutes.js, commerceRoutes.js, …
src/routes/auth.js, payment.js, admin.js
src/services/otpService.js, places.js, smsService.js, notificationService.js
```

There is **no `config.get(key)` facade** in the application read path (grep for
`config.get(`/`getConfig(` finds only *enterprise-kernel-internal* uses in
`application/workflow` and `application/ai`, not app config consumption).

**(b) `env.js` is a synchronous module exporting a static object, loaded first.**
`server.js:24` does `require('./src/config/env')` **before** any platform/kernel boot. `env.js`
ends by exporting a plain `{...}` of typed values. Values are frozen into the consumers' closures
at that instant.

**(c) The Configuration Kernel read API is asynchronous and platform-dependent.**
`src/application/config/index.js`: `init: () => service.reload(...)` is **async** ("`init()`
builds the first snapshot (async provider load); after that the read API … is synchronous").
The kernel cannot produce a snapshot **synchronously at `env.js` load time**, and it needs the
composed platform (which boots *after* `env.js`).

### Why the three facts together are a hard block
To make the kernel the *primary read source*, a consumer's read must be **redirectable at
runtime**. Given (a)+(b), the only redirection points are:

- **Option A — introduce a runtime facade `config.get(key)` and migrate all 16 consumers to it.**
  That is **modifying application modules** — including `auth.js` (authentication) and the
  routers (routing) — which this phase **explicitly forbids** ("Do not modify authentication /
  routing / Flutter APIs"), and it is a **refactor** (also forbidden). It is also not a
  "Configuration-only" change.
- **Option B — construct + `await init()` the Config kernel *inside* `env.js`** so its static
  exports come from the kernel. Invalid: `env.js` is synchronous and loads before the platform;
  you cannot `await` an async kernel snapshot there, and doing so introduces a circular
  dependency (`env.js` → platform → kernels → `env.js` seed) and boot-ordering hazards.

Both are ruled out. The **only remaining "authoritative" wiring** compatible with the phase rules
would seed the kernel from `env.js` and read the same values back — i.e., the kernel returns
exactly what `env.js` computed. That changes nothing observable, cannot run synchronously for the
existing consumers, and adds a redundant layer → **technical debt with zero value**, violating
"Do not introduce technical debt" and failing the very objective ("prove the platform can own
production behavior" — it wouldn't be owning anything).

## 3. Correction to prior work (intellectual honesty)

My own **P1-5 Config Promotion Readiness** stated *"no application module change required beyond
the seam; env.js stays the seed and the fallback."* **That was wrong**: it assumed a runtime
config facade ("the seam") already existed. It does not. This blocking report supersedes P1-5's
"ready to promote without consumer changes" conclusion. (Consistent with this engagement's rule:
*do not assume prior work is correct — including my own.*)

Note this does **not** change the separate, correct P1-5 finding that ADR-047 **Gate B1 (DB
provider) is N/A** for Configuration — Config is env-backed. The blocker here is a *read-seam*
problem, not a persistence problem.

## 4. Impact of proceeding anyway (why not to)

- A fake authoritative path risks the **highest-blast-radius config values** (`JWT_SECRET`,
  `PORT`, `ADMIN_PHONES`, CORS origins) flowing through an unnecessary async layer at boot — with
  no upside and new failure modes — directly contradicting "Zero production behavior regression."
- It would set a precedent that "promotion" = a no-op wrapper, undermining the credibility of the
  whole G1.0 programme and every future kernel promotion.

## 5. Proper engineering fix (recommended — a separate, properly-scoped phase)

**Phase 18.3 — Runtime Configuration Facade (prerequisite for any config promotion).**
1. Introduce a runtime facade `config.get(key)` / `config.require(key)` that returns the
   **`env.js` value by default** (behavior-identical) and is the single read seam.
2. **Incrementally migrate** the 16 consumers to the facade — one module per PR, each guarded by
   the existing A/B harness proving byte-identical HTTP responses (this is the "modify consumers"
   work that 18.2 forbids, so it needs its own approved phase, done safely and reversibly).
3. Only **after** the facade is the read path can `CONFIG_AUTHORITATIVE` meaningfully route
   `config.get` through the Configuration Adapter (with mandatory `env.js` fallback) — at which
   point the 18.2 promotion design becomes valid and executable exactly as specified.
4. Sequencing: 18.3 (facade) → re-run this promotion (18.2') → `ADR-048`.

**Effort/risk:** the facade + migration is Medium effort, Low risk (each step A/B-verified,
flag-reversible). It is the honest path to a *real* first promotion.

## 6. What was and was not done

- **Done:** independent prerequisite verification; root-cause analysis with evidence; correction
  of P1-5; recommended fix.
- **Not done (by design):** no `CONFIG_AUTHORITATIVE` flag, no authoritative read path, no
  ADR-048, no CHANGELOG "promoted" entry, no A/B/fault/perf harness for a promotion that must not
  ship. **No files were modified** in this phase (report-only).

## 7. Final recommendation

**Do not promote Configuration in Phase 18.2.** Authorize **Phase 18.3 (Runtime Configuration
Facade)** as the true prerequisite; execute the Configuration promotion immediately afterward
using the already-designed authoritative path. This preserves the programme's core discipline —
*never work around a failure* — and yields a promotion that is real, safe, and fully reversible
rather than cosmetic.
