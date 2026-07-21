# Enterprise Kernel Promotion History

A permanent, append-only record of every Enterprise kernel promotion past `Verified` on the
G1.0 §10 ladder. Each entry cites the authorizing ADR and the evidence.

| Date | Kernel | From → To | Flag | ADR | Evidence | Owner sign-off |
|---|---|---|---|---|---|---|
| 2026-07-21 | Configuration (ADR-019) | Verified → **Candidate Ownership** | `CONFIG_AUTHORITATIVE` (default OFF) | ADR-048 | 100% shadow parity; HTTP A/B (`config-authoritative-ab.mjs`) byte-identical; 11/11 in-process A/B + fault-injection; lookup latency no regression | ⬜ pending production soak (see PRODUCTION_SOAK_PLAN) |

## Ladder reference (G1.0 §10)

`Verified` → `Production Shadow` → `Candidate Ownership` → `Authoritative`.

- **Candidate Ownership** = the authoritative read path is implemented, flag-gated (default OFF),
  A/B-proven byte-identical, with mandatory legacy fallback and instant rollback. The kernel is not
  yet the in-production source until the soak passes and the flag is enabled.
- **Authoritative** = the flag is enabled in production after a zero-drift soak and Owner sign-off.

## Notes

- No kernel other than Configuration has been promoted past `Verified`.
- Configuration owns **no persistent state** (env-backed); rollback is lossless and flag-only.
- `env.js` is retained permanently as bootstrap seed, mandatory fallback, and emergency recovery.
