# Enterprise Compatibility Kernel — Rollback Plan (ADR-041)

The Compatibility Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-040) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/compatibility` or
  `src/domain/compatibility`. The kernel is only instantiated by an explicit
  `createCompatibilityPlatform(...)` call, which the base platform does not make.
- **Decides, does not embed.** The kernel answers compatibility queries off the hot path; no
  other kernel depends on it, so removing it cannot affect them. It reuses the shared
  `semver` and `integrity.checksum` extensions but does not modify them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local
  (`src/domain/compatibility/events.js`); the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/compatibility/`
   - `src/application/compatibility/`
2. Delete the tests:
   - `tests/unit/compatibility.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-041-compatibility.md`
   - `docs/COMPATIBILITY-DEVELOPER-GUIDE.md`, `docs/COMPATIBILITY-PROVIDER-GUIDE.md`,
     `docs/COMPATIBILITY-ROLLBACK-PLAN.md`
   - `docs/diagrams/compatibility-architecture.mermaid`,
     `docs/diagrams/compatibility-flow.mermaid`
4. Remove any composition-root call you added that wires
   `createCompatibilityPlatform(...)` (the base platform has none).

```bash
rm -rf src/domain/compatibility src/application/compatibility tests/unit/compatibility.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 32 compatibility tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createCompatibilityPlatform(...)` is called, leaving
the factory uncalled fully disables it without deleting code. No contract data persists
anywhere in the base platform, since the default provider is in-process and lives only for
the lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds contract metadata in-process only; removing the kernel
discards that in-memory state. If a real store (PostgreSQL/Storage/Redis/MongoDB/cloud) had
been wired, contract definitions + deprecation status live in that external system and are
unaffected by removing the kernel code — decommission it separately per its own runbook.
