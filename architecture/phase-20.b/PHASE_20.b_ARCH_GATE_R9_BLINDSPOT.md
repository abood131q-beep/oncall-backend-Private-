# Phase 20.b (cont.) — Architecture Gate R9: Closing the Edge-Layer Blind Spot

## What this fixes

Phase 19.1 found that `src/middleware/` and `src/services/` are **not** among the four ADR-005 layers
the architecture gate scans (R1–R7), so **raw SQL and token-signing crypto have hidden there** — the
"governance blind spot" behind violations V1 (JWT crypto in middleware) and V2 (SQL outside
infrastructure). **R9 closes it**: the gate now scans these edge folders and forbids **new** raw SQL
and **new** HMAC token crypto in them, while making the **existing debt explicit and machine-tracked**.

## R9 rules (MAJOR, ratchet)

- **R9-no-sql-in-edge** — no raw SQL in `middleware/` or `services/` (belongs in `infrastructure/`).
- **R9-no-token-crypto-in-edge** — no `createHmac(...)` token signing in those folders (belongs in
  the Identity kernel infrastructure, ADR-049).

Like R8, R9 is a **ratchet**: the allowlists hold the pre-existing debt and may only **shrink** as
each responsibility migrates into the kernel/infrastructure. Any file **not** on the allowlist that
introduces SQL/HMAC in these folders is a hard violation → CI fails.

## The debt is now visible (the allowlist = the 19.1 inventory)

SQL debt (allowlisted, to be migrated):
`middleware/auth.js` (refresh + revocation SQL — V2), `middleware/rateLimiter.js`,
`services/otpService.js` (OTP store — V2/identity), `services/driverMatcher.js`,
`services/analytics.js`, `services/notificationService.js`.

Token-crypto debt (allowlisted): `middleware/auth.js` (hand-rolled HS256 JWT — V1).

Each entry is a tracked item that the future consolidation must remove; the allowlist shrinking to
empty is the mechanical definition of "V1/V2 resolved for identity."

## Proof (ratchet works both ways)

- Gate **R1–R9 PASS (0 violations)** with the current allowlists (existing debt tracked, not blocking).
- A synthetic new `middleware/` file containing `createHmac` + SQL was **correctly flagged**
  (R9-no-token-crypto-in-edge MAJOR). The R9-SQL regex (shared with R2) matches real
  `DELETE/INSERT/UPDATE/SELECT col` statements (verified).

## Validation

- Architecture gate **R1–R9 PASS (0 violations)**.
- Unit regression **903/903**; other shadows + Config authoritative unchanged (`verify:shadow` PASS).
- No production code changed — R9 is a governance/tooling rule only. Legacy identity remains
  authoritative; behavior unchanged.

## Impact on the identity migration

R9 turns the 19.1 V1/V2 debt from an invisible narrative into a **CI-enforced, shrinking allowlist**.
When the JWT crypto and refresh/revocation SQL actually move from `middleware/auth.js` into the
Identity kernel infrastructure (the real consolidation), their allowlist entries are removed and R9
guarantees they never come back — and that no NEW edge-layer SQL/crypto is introduced meanwhile.

## Host actions (sandbox FUSE limitation)

Two inert R-ratchet test probes could not be unlinked from the sandbox and are neutralized (no
SQL/crypto, gate-clean); delete host-side:
`git clean -f src/services/__ratchet_probe.js src/middleware/__r9_probe.js`. Also commit all pending
changes on the host.
