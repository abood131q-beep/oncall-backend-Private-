# Phase 20.b — Runbook: Cross-Replica Revocation & Rollback Drill (staging)

Two Gate B2 criteria need infrastructure not present in CI-without-Redis / the validation sandbox.
This runbook is how to produce that evidence in staging. Nothing here changes production; all flags
default OFF.

## B2.2 — Cross-replica revocation timing (needs ≥2 replicas + Redis)

**Harness:** `tests/integration/identity-cross-replica-revocation.mjs`
(`npm run identity:cross-replica`).

**What it proves:** enabling the Identity Shadow does not change how fast a token revoked on replica A
becomes invalid on replica B (Redis-backed propagation — `middleware/auth.js` Phase-12/C2 +
`onCallApplication.js` `setRevocationPublisher`/`subscribeRevocations`).

**How to run (staging / CI-with-Redis):**
```
export REDIS_URL=redis://<host>:6379            # required — skip-clean if absent
# optional: export XREPLICA_TOLERANCE_MS=3000
npm run identity:cross-replica
```
It boots two replicas sharing one DB + Redis, logs in on A, `/auth/logout-all` on A, polls
`/auth/verify` on B until 401, measuring propagation ms — first with the shadow OFF (baseline), then
ON — and asserts B rejects in both and the ON timing is within tolerance of OFF. Without `REDIS_URL`
it prints `UNAVAILABLE / SKIPPED` and exits 0 (no fabricated result).

**CI wiring option:** add a `redis` service container to a dedicated job and run the harness with
`REDIS_URL` set; upload the printed timings as the B2.2 artifact.

## B2.3 — Staged rollback, no client re-auth

**Harness:** `scripts/identity-rollback-drill.mjs` (`npm run identity:rollback-drill`).

**What it proves (measured now):** the rollback-SAFETY invariant — a session (access + refresh)
minted BEFORE a flag flip stays valid AFTER it, so a rollback never forces clients to re-authenticate.
It mints a session on a server, restarts with the identity flags toggled (same DB), and asserts the
same access token still verifies (200) and the same refresh token still rotates (200). **Measured
PASS** in Phase 20.b.

**20.c completion:** `IDENTITY_AUTHORITATIVE` is introduced in Phase 20.c. The same drill then flips
that authoritative flag (ON → mint session → OFF rollback → same session valid), completing B2.3 as a
true authoritative-path rollback. The drill already detects whether the flag is wired
(`identityAuthoritativeWired`) and reports accordingly.

## Gate B2 status aggregation

`scripts/identity-gate-b2.mjs` (`npm run identity:gate-b2`) runs the pure parity, socket A/B, HTTP +
refresh/revocation A/B, and rollback drill; folds in cross-replica when `REDIS_URL` is set; and writes
`architecture/phase-20.b/evidence/gate-b2-evidence.json`. It records only measured results and never
declares Gate B2 fully MET while any criterion is UNAVAILABLE/PARTIAL.

## Guardrails

- All identity flags (`PLATFORM_IDENTITY`, `SHADOW_IDENTITY`, `IDENTITY_AUTHORITATIVE`) default **OFF**.
- Legacy `middleware/auth.js` remains authoritative throughout. These harnesses only observe/compare.
- No promotion, no flag flip in production, until Gate B2 is fully MET (all criteria measured) and an
  Owner-signed promotion ADR (ADR-050) exists — per ADR-047.
