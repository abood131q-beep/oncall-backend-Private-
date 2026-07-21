# Enterprise Lifecycle Management Kernel — Rollback Plan (ADR-040)

The Lifecycle Management Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-039) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/lifecycle` or
  `src/domain/lifecycle`. The kernel is only instantiated by an explicit
  `createLifecyclePlatform(...)` call, which the base platform does not make.
- **Orchestrates, does not embed.** Components hand plain hook functions to the engine; no
  other kernel depends on the lifecycle kernel, so removing it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/lifecycle/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/lifecycle/`
   - `src/application/lifecycle/`
2. Delete the tests:
   - `tests/unit/lifecycle.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-040-lifecycle-management.md`
   - `docs/LIFECYCLE-DEVELOPER-GUIDE.md`, `docs/LIFECYCLE-PROVIDER-GUIDE.md`,
     `docs/LIFECYCLE-ROLLBACK-PLAN.md`
   - `docs/diagrams/lifecycle-architecture.mermaid`, `docs/diagrams/lifecycle-flow.mermaid`
4. Remove any composition-root call you added that wires `createLifecyclePlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/lifecycle src/application/lifecycle tests/unit/lifecycle.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 17 lifecycle tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createLifecyclePlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No component data persists anywhere
in the base platform, since the default provider is in-process and lives only for the
lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds component metadata in-process only; removing the kernel
discards that in-memory state. If a real store (PostgreSQL/Storage/Redis/MongoDB/cloud) had
been wired, component definitions + last-known state live in that external system and are
unaffected by removing the kernel code — decommission it separately per its own runbook.
Executable hooks are always in-process and are simply forgotten on removal.
