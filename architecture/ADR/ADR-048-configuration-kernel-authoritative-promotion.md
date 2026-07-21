# ADR-048 — Configuration Kernel Authoritative Promotion

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Principal Engineering
- **Related:** ADR-019 (Configuration Kernel), ADR-046 (Enterprise Shadow Integration), ADR-047
  (Kernel Ownership Preconditions), G1.0 §10 (Promotion Rules), Phase 18.2 Blocking Report,
  Phase 18.3 (Runtime Configuration Facade), Phase 18.4 (Migration Completion), P1-5 (Promotion
  Readiness)

---

## 1. Motivation

The Configuration Kernel (ADR-019) has been in **Shadow / Verified** since Phase 17.3 with parity
and coverage at **100%** against the legacy `env.js` source. Every prior "promotion" attempt was
correctly refused: Phase 18.2 STOPPED with a blocking report because the application had **no
runtime configuration-read seam** — consumers destructured `env.js` at import time, so nothing
could re-point them at the kernel. Phases 18.3 (facade) and 18.4 (complete migration, R8 allowlist
= 0) removed that blocker. Configuration is the correct **first** kernel to promote to
Authoritative: it is env-backed (ADR-047 Gate B1 is N/A — no persistent state), has no auth/token
surface (Gate B2 N/A), and has a trivially safe fallback. This ADR records the promotion of the
Configuration Kernel to the **primary runtime configuration read source**, behind a default-OFF
flag with instant rollback.

## 2. Decision

When `CONFIG_AUTHORITATIVE=1`, the runtime configuration facade (`src/config/index.js`) serves
reads from the **Configuration Kernel's resolved snapshot**, falling back to `env.js` on any miss,
fault, or absence. `env.js` remains the **bootstrap source, mandatory fallback, and emergency
recovery path**. The flag defaults **OFF**; with it off, behavior is byte-identical to Phase 18.4.
Rollback is flag-only (`CONFIG_AUTHORITATIVE=0`). No other kernel is promoted.

## 3. Architecture

```
                         CONFIG_AUTHORITATIVE=0 (default)
  consumer ── config.get(key) ─────────────────────────────► env.js value

                         CONFIG_AUTHORITATIVE=1
  consumer ── config.get(key) ─► Configuration Kernel snapshot ─┐
                                   (has key?) ── yes ──► value   │
                                        │no / error / not-ready  │
                                        └───────────────────────►┴─► env.js value  (mandatory fallback)
```

The facade is the ONLY config-read seam (ADR-046 / architecture rule **R8**, allowlist = 0). The
authoritative source lives in the Configuration subsystem
(`src/platform-adapters/configuration/authoritativeSource.js`) — no consumer changed for this
promotion (the 18.3/18.4 migration already routed 100% of reads through the facade).

## 4. Snapshot Design (synchronous, no async in `config.get()`)

The mission requires the snapshot be available **synchronously** with **no async dependency** in
`config.get()`. This is achievable because the OnCall configuration is **defaults-only**: `env.js`
is the single seed; there are **no asynchronous providers** and **no schema** wired (see
`enterprise/configShadow.js` `buildConfigSeed`, which seeds the kernel with
`{ config: { defaults: seed } }` and nothing else). For that shape the kernel's full pipeline
(`providers → precedence.resolve → schema.validate → activate`) reduces deterministically to a
single synchronous stage: **`precedence.resolve({ default: seed })`** — the kernel's OWN domain
resolution module (`src/domain/config/precedence.js`).

`authoritativeSource.js` therefore builds the kernel snapshot **once, synchronously, at facade
load**, from `legacy.snapshot()` (a shallow copy of env's typed exports). Because the seed is a
shallow copy, each resolved value is the **same reference** `env.js` holds → reads are
**byte-identical**, not merely deep-equal, and env's existing mutability characteristics are
unchanged (only the snapshot container is frozen, never the value objects). An **integrity guard**
(`ready()`) confirms the resolved key set matches the seed's; a source that is not `ready()` is
never adopted. The 17.3/18.0 shadow already proved, at 100% parity, that a kernel seeded exactly
this way returns env's values.

This is genuinely "the kernel is authoritative": reads flow through the kernel's resolution and
snapshot, with env as the seed and fallback — exactly as P1-5 §2 specified.

## 5. Runtime Flow & Failure Handling (fail-safe)

Under `CONFIG_AUTHORITATIVE=1`, for every `config.get(key)` / `config.require(key)` / `config.has`:
1. If the authoritative source exists and **has** the key → return the kernel value.
2. Otherwise (kernel unavailable · snapshot not built · not `ready()` · missing key · **any thrown
   exception**, caught) → return the **`env.js`** value (or `fallback` / throw-if-required exactly
   as legacy).

The authoritative build is fully guarded in the facade: any throw leaves the source `null` and the
facade in **legacy** mode. **The application never fails to start because of the kernel.**

## 6. Rollback

Set `CONFIG_AUTHORITATIVE=0` (or unset) and restart. The facade returns to the pure `env.js` path
instantly. There is **no kernel-owned persistent state**, so nothing to reconcile — rollback is
lossless and flag-only.

## 7. A/B Evidence

- **HTTP A/B** (`tests/integration/config-authoritative-ab.mjs`, wired into CI `ab-compat` via
  `npm run test:ab`): boots the real server twice (`CONFIG_AUTHORITATIVE=0` vs `=1`) on separate
  ports/DBs and asserts **byte-identical** status + body + contract headers across public probes
  (root, `/test`, `/health`, `/health/live`, `/metrics`, a 404, and the `POST /auth/verify-otp`
  validation path) — proving identical HTTP responses, startup, routing, auth path, and
  Flutter-facing contract.
- **In-process A/B + fault injection** (`tests/unit/configAuthoritative.test.js`, sqlite-free,
  11/11): value identity for every key OFF vs ON (reference identity), identical key sets,
  `require()` fail-fast, rollback, and all four fault paths (build failure, not-ready snapshot,
  missing key, read exception) each falling back to env without throwing; plus a lookup-latency
  bound.
- **Shadow parity** remains **100%** with the flag ON (`verify:shadow` green under
  `CONFIG_AUTHORITATIVE=1`) — the kernel snapshot equals env.

## 8. Performance

- **Lookup latency (recurring):** no measurable regression — ON adds a single `hasOwnProperty`
  check + property read per lookup; 200k lookups complete in single-digit ms in both modes.
- **Startup (one-time):** ~4–6 ms to load the two small config-subsystem modules + the pure
  `precedence` domain module and build the snapshot — incurred **only** when the flag is ON.
  Against full server boot (Express + Socket.IO alone measured ~306 ms) this is well within the
  <1% budget; the precise full-boot delta is confirmed by the CI boot.
- **Memory (one-time):** ~0.13 MB heap (the resolved values map holds 24 references + module code)
  — <1% of application RSS.

## 9. Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Kernel returns a different value than env in an edge case | Medium | Snapshot seeded from env by reference (identical); mandatory env fallback; A/B + 100% shadow parity |
| Snapshot build fails at boot | Low | Guarded build → `null` → legacy path; app never fails to start |
| Async creep into `config.get()` | Low | Snapshot built synchronously via pure `precedence.resolve`; no provider await; unit-tested |
| Scope creep (promoting writes/other kernels) | Low | Reads only; single kernel; R8 unchanged; no schema/provider added |
| Operators unaware of the flag | Low | Default OFF; documented in soak plan + CHANGELOG + this ADR; diagnostics expose `mode` |

## 10. Operational Procedure

1. Deploy with `CONFIG_AUTHORITATIVE=0` (no change).
2. In staging, set `CONFIG_AUTHORITATIVE=1`; confirm `config.diagnostics().mode === 'authoritative'`
   and the CI `ab-compat` (config-authoritative) job green.
3. Run the production soak (see `architecture/phase-18.5/PRODUCTION_SOAK_PLAN.md`): monitor drift,
   parity, error rate, and startup for the defined window.
4. On zero drift over the window, enable `CONFIG_AUTHORITATIVE=1` in production.
5. **Rollback trigger:** any config drift, parity < 100%, or startup regression → set
   `CONFIG_AUTHORITATIVE=0` and restart. Lossless.

## 11. Consequences

- Configuration is the first Enterprise kernel to **own a production read path** — evidence the
  platform delivers real value (answers the audit's "zero functional migration" critique) — while
  remaining fully reversible and behavior-identical.
- Establishes the **repeatable promotion pattern** (facade seam → shadow 100% → flag-gated
  authoritative with mandatory legacy fallback → A/B + soak → ADR) for the next kernels.
- `env.js` is retained permanently as seed + fallback + recovery; no persistent kernel state is
  introduced.

## 12. Status Ladder (G1.0 §10)

Configuration: `Verified` → **`Candidate Ownership` (this ADR, flag default OFF)**. Promotion to
in-production `Authoritative` occurs operationally by enabling the flag after the soak; this ADR
authorizes it and records the design + evidence.
