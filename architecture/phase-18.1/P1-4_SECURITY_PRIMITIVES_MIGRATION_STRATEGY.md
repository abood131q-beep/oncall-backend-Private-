# P1-4 — Security-Primitive Migration Strategy (`jose` / `dotenv`)

**Status:** Strategy only — **no implementation in this phase** (per mission). This document is
the required "migration strategy before implementation."

**Scope:** evaluate replacing two hand-rolled primitives flagged by the audit (H-3):
1. Hand-rolled HS256 **JWT** in `src/middleware/auth.js` → **`jose`**.
2. Hand-rolled **`.env` parser** in `src/config/env.js` → **`dotenv`**.

**Hard constraints:** never change runtime behavior; never change token format unless proven
byte-compatible; never break Flutter compatibility.

---

## 1. Current state (verified)

- **JWT:** hand-signed/verified HS256 — `crypto.createHmac('sha256', JWT_SECRET)` +
  `timingSafeEqual`, length-guarded, `exp` + per-phone revocation checked, headers-only tokens,
  alg hardcoded (defeats alg-confusion). **Currently correct**, but hand-rolled auth crypto is a
  standing assurance risk (no `nbf/aud/iss`, easy to regress, no external audits).
- **env:** a bespoke line-splitter that strips quotes, skips comments, normalizes `LOG_LEVEL`,
  fail-fasts on missing `JWT_SECRET`, and exports **typed** values (numbers, booleans, arrays,
  parsed Firebase JSON).
- **Neither `jose` nor `dotenv` is currently a dependency.**

## 2. Why migrate (and why carefully)

- **Assurance:** `jose` is a widely-audited JWT/JOSE library; moving off hand-rolled crypto
  reduces long-term regression risk and unlocks `nbf/aud/iss`/key-rotation cleanly.
- **Risk of migration:** JWT touches **live Flutter sessions** — the single highest-blast-radius
  surface. `dotenv` touches startup config parsing. Both must be behavior-preserving.

## 3. Byte-compatibility analysis (the crux for JWT)

- **Token FORMAT is preservable** (JWT, HS256, same claims, same `exp` policy: 15m access / 24h
  admin / 30d refresh).
- **Token STRING byte-identity is NOT guaranteed** for *newly issued* tokens: the current code
  serializes `JSON.stringify({...payload, iat, exp})` with a specific key order; `jose` orders
  claims via its builder, likely producing a different base64url body → a different string.
- **This is acceptable and safe** because:
  - JWTs are **opaque** to clients (Flutter stores/sends them verbatim); a differently-ordered
    but valid token works identically.
  - HS256 verification recomputes the HMAC over the exact received `header.body`, so **tokens are
    mutually verifiable**: `jose`-issued tokens verify under the legacy verifier and vice-versa,
    and **all existing live tokens remain valid** after cutover.
- **If exact byte-identity is required** (e.g., golden-file tests), it can be forced by pinning
  the protected header to `{"alg":"HS256","typ":"JWT"}` and preserving claim insertion order — but
  this is unnecessary for correctness and adds coupling; recommend **not** requiring it.

## 4. Recommended approach — shadow-verified cutover (aligns with G1.0)

Reuse the platform's own methodology to de-risk the auth change:

**Phase A — Shadow verify (no behavior change).**
- Keep `middleware/auth.js` authoritative. Add a `jose`-based verify/sign path behind a flag
  (`SHADOW_AUTH`, default OFF), compared out-of-band:
  - For every incoming token, run both verifiers; assert **identical decision** (valid/invalid)
    and **identical decoded claims**; record parity/mismatch metrics (reuse `_shadow`).
  - For issuance, sign with both; assert both verify under both; assert claim-set equality.
- Ship only after parity = 100% over a production soak (this is exactly ADR-047 Gate **B2** for
  Identity — Identity-token parity — so this work *also* advances the Identity kernel).

**Phase B — Cutover behind a flag.**
- `PLATFORM_AUTH_JOSE=1` routes issuance/verify through `jose`; legacy stays as instant rollback.
- No token-format change; existing tokens keep verifying.

**`dotenv` (lower risk, lower priority).**
- Keep `env.js` as the **typed/validated facade** (its real value). Replace only the internal raw
  line-parser with `dotenv.parse`, preserving every downstream computation (LOG_LEVEL normalize,
  `JWT_SECRET` fail-fast, typed exports).
- Verify by golden-fixture comparison: for a set of `.env` fixtures, assert `env.js` exports are
  identical before/after. Gate in CI.

## 5. Rollback & verification

- **Rollback:** flag-only (`SHADOW_AUTH=0`, `PLATFORM_AUTH_JOSE=0`) — legacy hand-rolled path
  restored instantly.
- **Verification gates before cutover:** 100% auth-shadow parity over soak; all A/B harnesses
  byte-identical; existing tokens verify; `npm audit` clean for `jose`/`dotenv`.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Token drift breaks live sessions | High | Shadow-verify to 100% before cutover; mutual verifiability keeps old tokens valid; flag rollback |
| `dotenv` edge-case parse differences | Medium | Keep env.js facade; golden-fixture parity in CI |
| New dependency supply-chain surface | Low | `jose`/`dotenv` are minimal, audited; `npm audit` gate |
| Scope creep into Identity kernel | Low | Frame Phase A explicitly as ADR-047 Gate B2 progress |

## 7. Remaining blockers

- No blocker to *starting* Phase A (shadow). Cutover is blocked on a 100% auth-parity soak.

## 8. Recommendation

- **Proceed with `jose` via the shadow-verified path** (Phase A first) — it is the correct
  long-term move and doubles as ADR-047 Gate B2 evidence for Identity. Do **not** change token
  format; rely on mutual verifiability.
- **`dotenv`: optional/low priority** — only worthwhile as an internal parser swap behind the
  env.js facade with golden-fixture parity; defer unless a parsing bug appears.
- **Do not implement in this phase** — this is the strategy; implementation is a separate,
  flag-gated, shadow-verified change.
