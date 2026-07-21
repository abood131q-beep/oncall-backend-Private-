# Phase 20.b (cont.) — Shadow Coverage Closure (refresh / revocation / repository)

## What this closes

The gap analysis flagged that the shadow's `refresh` and `repository` categories were **declared but
never exercised** — so they reported a **misleading 100% on zero comparisons**. This step makes them
**real, measured** comparisons and makes the reporting **honest**.

## Changes

- **Shadow (`shadow.js`)** now supports **async DB comparisons** (`recordAsync`) and adds
  `shadowVerifyRefresh`, `shadowFindUser`, `shadowFindDriver` (categories `refresh` / `repository`).
  It **never throws/rejects** to the caller; a kernel DB exception is captured as a verification
  failure. **Reporting fix:** a category with **zero** comparisons now reports `parityPct = null`
  (not `100`) — coverage is explicit.
- **Kernel repository port** (`infrastructure/identity/identityRepository.js`) is now a pass-through
  when wired (inert `NotWired` when not), matching the token/otp adapters. `legacySource` /
  `kernelSource` gained `verifyRefresh` / `findUserByPhone` / `findDriverByPhone`; the enterprise
  wiring composes the repository port when DB primitives are supplied.
- **New harness** `scripts/identity-db-parity.mjs` (`npm run identity:db-parity`) — opens a **real
  sqlite DB** (via the dev compat preload), migrates it (`config/migrate`), issues refresh tokens
  through the certified primitives, and drives **real legacy-vs-kernel comparisons** for refresh
  (valid / rotated / revoked / invalid / null) and repository reads (present + missing).
- **Gate B2 generator** now runs the DB parity harness and folds it into criterion **B2.1** evidence.

## Measured result (this environment, real DB)

```
refresh comparisons ran = 5     refresh parity 100%
repository comparisons ran = 4  repository parity 100%
mismatches 0                    verificationFailures 0
```

Evidence: `architecture/phase-20.b/evidence/identity-db-parity.json`. So refresh/revocation/repository
parity is now **backed by real comparisons with non-zero coverage**, not a trivial default.

## Validation

- Unit regression **903/903** (incl. new async-DB-method tests + an honest-null test).
- Architecture **R1–R8 PASS (0 violations)**; ESLint PASS; other shadows + Config authoritative unchanged.
- Legacy `middleware/auth.js` / OTP / gateways unchanged; kernel repo/token remain **pass-through**
  (non-authoritative); production behavior unchanged (flags default OFF).

## Honest note on what this does and does NOT prove

It proves the kernel's DB **seam** (token + repository ports) reproduces legacy behavior faithfully
end-to-end (pass-through). It does **not** prove an *independent* reimplementation, because the kernel
still delegates the JWT/refresh/revocation/OTP/repo work to legacy — the actual behavior migration out
of `middleware/auth.js` / `services/` (19.1 V1/V2) remains future work. This closure only removes the
misleading zero-coverage 100% and gives real refresh/repository parity evidence.

## Gate B2 status (unchanged verdict)

Still **SUBSTANTIALLY MET, not fully MET**: token/claims + HTTP + **refresh/revocation/repository** +
socket measured PASS; rollback-safety measured PASS (B2.3 PARTIAL — 20.c flag); **B2.2 cross-replica
UNAVAILABLE** (staging/Redis). No promotion until the remaining evidence is produced and ADR-050 +
Owner sign-off exist.
