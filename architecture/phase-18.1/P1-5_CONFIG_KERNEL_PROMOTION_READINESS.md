# P1-5 — Configuration Kernel Promotion Readiness

**Status:** Readiness report — **the Configuration kernel is NOT promoted in this phase** (per
mission). This document verifies the promotion gates, designs the DB-backed/authoritative
provider path, and states rollback/parity/A-B verification, per ADR-047.

**Headline finding:** **Configuration is the ideal first kernel to promote to authoritative** —
and its promotion is **not blocked by ADR-047 Gate B1**, because Configuration is **env-backed,
not persistent-state-backed**. The gate that matters (value parity) is already met at 100%.

---

## 1. ADR-047 gate analysis for Configuration

### Gate B1 — Byte-compatible DB-backed provider → **N/A for Configuration (verified)**
- **Evidence:** `src/application/config/providers/` contains `envProvider.js`, `jsonFileProvider.js`,
  `memoryProvider.js` — **no persistent DB store**. Configuration's Source of Truth is `env.js`
  (process env), not a SQLite/PG table.
- **Consequence:** Gate B1, which requires a DB-backed provider reading the *existing tables*,
  **does not apply** to Configuration. There is no persistent state to own. This is a material
  reframing of the audit's C-2/B1 conclusion: B1 blocks Storage/Rate-Limit/Notifications/Jobs/
  Identity — **not Config.** The correct provider for Config is an **env provider**, which already
  exists and is already parity-proven.

### Gate B2 — Identity token parity → **N/A for Configuration**
- Configuration has no auth/token surface.

### The gate that *does* apply — value parity → **MET (100%)**
- 17.3 + 18.0 verification: `verify:shadow` shows **configuration parity 100%, coverage 100%**,
  0 mismatches, 0 verification failures, across the full env surface (strings, numbers, booleans,
  arrays, objects, null, missing, sensitive keys redacted). The kernel is seeded from the exact
  typed values `env.js` computes, so reads are lossless.

**Conclusion:** Configuration clears the applicable promotion preconditions **today**.

## 2. Promotion mechanism design (authoritative read path — NOT enabled here)

Promotion = the application reads configuration **from the kernel** instead of `env.js`, while
`env.js` remains the seed + fallback. Design (flag-gated, reversible, G1.0-compliant):

- **New flag:** `CONFIG_AUTHORITATIVE` (default OFF). `SHADOW_CONFIG` remains for the shadow.
- **State ladder (G1.0 §10):** `Verified` → `Production Shadow` (soak) → `Candidate Ownership`
  (this design) → `Authoritative` (flag ON, via a promotion ADR).
- **Read path when ON:** the Configuration Adapter's `get(key)` becomes the primary read, with a
  **mandatory `env.js` fallback** on any kernel miss/error (fail-safe: never worse than legacy).
  Because the kernel is seeded from `env.js`, values are identical; the fallback guarantees no
  regression even on kernel fault.
- **No application module change required beyond the seam:** only the config-access facade routes
  through the adapter; `env.js` stays the seed and the fallback. Sensitive-value handling
  unchanged (never exposed; redacted in records).
- **Reversibility:** `CONFIG_AUTHORITATIVE=0` → reads return to `env.js` directly (instant
  rollback, no data risk — there is no persistent kernel state).

## 3. Rollback verification (design)

| Action | Effect | Data risk |
|---|---|---|
| `CONFIG_AUTHORITATIVE=0` | reads via `env.js` (legacy) | None (no kernel-owned state) |
| `SHADOW_CONFIG=0` | stop comparisons | None |
| `PLATFORM_CONFIG=0` | kernel port detached | None |

Rollback is flag-only and lossless — Configuration owns no persistent state, so there is nothing
to reconcile.

## 4. Parity & A/B verification plan (before any promotion)

1. **Parity:** continue `verify:shadow` at 100% (already green) + a production soak with the
   config shadow enabled; require zero drift over the soak window (G1.0 §10 confidence/coverage).
2. **A/B:** a `config-authoritative-ab.mjs` harness booting `CONFIG_AUTHORITATIVE=0` vs `=1` and
   asserting **byte-identical** HTTP responses + identical startup config (the kernel path must be
   indistinguishable from `env.js`). Wire into the CI `ab-compat` gate.
3. **Fault injection:** verify the `env.js` fallback returns the correct value when the kernel is
   forced to miss/throw (fail-safe proof).
4. **Promotion ADR:** author `ADR-048` citing ADR-046/047, attaching the soak + A/B evidence,
   before flipping `CONFIG_AUTHORITATIVE` in production.

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Kernel returns a different value than env under some edge case | Medium | Mandatory env fallback + A/B gate + soak; kernel is seeded from env |
| Reload/runtime-config semantics differ | Low | Config is read-mostly at boot; document reload behavior; A/B covers it |
| Scope creep (promoting more than reads) | Low | Promote reads only; no writes/ownership of new state |

## 6. Remaining blockers (to actual promotion — not this phase)

- A production **soak** of the config shadow with zero drift (operational time, not code).
- The `config-authoritative-ab.mjs` harness + CI wiring (small, additive).
- A promotion **ADR-048** with attached evidence and Owner sign-off (governance).

## 7. Recommendation

- **Configuration is the correct first kernel to promote to authoritative** — it clears the
  applicable gates now, needs **no** DB-backed provider (B1 N/A), and has a trivially safe
  fallback. This is the lowest-risk way to prove the Enterprise Platform delivers *real*
  production value (answering the audit's C-1 "zero functional migration" critique).
- **Do NOT promote in this phase.** Next steps, in order: (1) run the production soak; (2) add the
  authoritative-A/B harness; (3) author ADR-048; (4) flip `CONFIG_AUTHORITATIVE` behind the flag
  with instant rollback.
- **Update the audit / ADR-047 note:** Gate B1 is **not** a blocker for Configuration; it blocks
  only persistent-state kernels.
