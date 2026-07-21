# Enterprise Background Jobs Kernel — Rollback Plan (ADR-032)

The Background Jobs Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-031) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/jobs` or
  `src/domain/jobs`. The kernel is only instantiated by an explicit
  `createJobsPlatform(...)` call, which the base platform does not make.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present, proving it adds no observable behavior to existing contracts.
- **Self-contained.** The domain event catalog is local (`src/domain/jobs/events.js`); the
  shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/jobs/`
   - `src/application/jobs/`
2. Delete the tests:
   - `tests/unit/jobs.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-032-background-jobs.md`
   - `docs/JOBS-DEVELOPER-GUIDE.md`, `docs/JOBS-PROVIDER-GUIDE.md`,
     `docs/JOBS-ROLLBACK-PLAN.md`
   - `docs/diagrams/jobs-architecture.mermaid`, `docs/diagrams/jobs-execution-flow.mermaid`
4. Remove any composition-root call you added that wires `createJobsPlatform(...)` (the base
   platform has none).

```bash
rm -rf src/domain/jobs src/application/jobs tests/unit/jobs.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 19 jobs tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createJobsPlatform(...)` is called — and only
executes work when something calls `tick()` — leaving the factory uncalled (or never
ticking) fully disables it without deleting code. No job data persists anywhere in the base
platform, since the default provider is in-process and lives only for the lifetime of an
instantiated kernel.

## Data considerations

The default memory provider holds jobs in-process only; removing the kernel discards that
in-memory state. If a real store (Redis/PostgreSQL/Storage/MongoDB/message queue) had been
wired, jobs live in that external system and are unaffected by removing the kernel code —
drain or decommission it separately per its own runbook. In-flight jobs that were mid-retry
are simply not resumed once the kernel is removed.
