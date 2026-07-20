# Enterprise Feature Flag Kernel — Rollback Plan (ADR-029)

The Feature Flag Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-028) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/features` or
  `src/domain/features`. The kernel is only instantiated by an explicit
  `createFeaturePlatform(...)` call, which the base platform does not make.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present, proving it adds no observable behavior to existing contracts.
- **Self-contained.** The domain event catalog is local (`src/domain/features/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/features/`
   - `src/application/features/`
2. Delete the tests:
   - `tests/unit/features.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-029-feature-flags.md`
   - `docs/FEATURES-DEVELOPER-GUIDE.md`, `docs/FEATURES-PROVIDER-GUIDE.md`,
     `docs/FEATURES-ROLLBACK-PLAN.md`
   - `docs/diagrams/features-architecture.mermaid`,
     `docs/diagrams/features-evaluation-flow.mermaid`
4. Remove any composition-root call you added that wires `createFeaturePlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/features src/application/features tests/unit/features.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 18 features tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createFeaturePlatform(...)` is called, a feature
flag at the composition root is sufficient to disable it without deleting code: simply do
not call the factory. No flag data persists anywhere in the base platform, since the
default provider is in-process and lives only for the lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds definitions in-process only; removing the kernel discards
that in-memory state. If a real provider (Storage/PostgreSQL/Redis/MongoDB/cloud config)
had been wired, definitions live in that external store and are unaffected by removing the
kernel code — decommission the external store separately per its own runbook. The
evaluation cache is purely in-memory and derived from definitions, so it needs no
migration.
