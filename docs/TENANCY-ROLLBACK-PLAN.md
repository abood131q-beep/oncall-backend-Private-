# Enterprise Multi-Tenancy Kernel — Rollback Plan (ADR-038)

The Multi-Tenancy Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-037) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/tenancy` or
  `src/domain/tenancy`. The kernel is only instantiated by an explicit
  `createTenancyPlatform(...)` call, which the base platform does not make.
- **Governs, does not modify.** Existing kernels already carry a `tenant` field; this kernel
  governs tenant definitions and resolution but never modifies another kernel, so removing
  it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/tenancy/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/tenancy/`
   - `src/application/tenancy/`
2. Delete the tests:
   - `tests/unit/tenancy.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-038-multi-tenancy.md`
   - `docs/TENANCY-DEVELOPER-GUIDE.md`, `docs/TENANCY-PROVIDER-GUIDE.md`,
     `docs/TENANCY-ROLLBACK-PLAN.md`
   - `docs/diagrams/tenancy-architecture.mermaid`, `docs/diagrams/tenancy-lifecycle.mermaid`
4. Remove any composition-root call you added that wires `createTenancyPlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/tenancy src/application/tenancy tests/unit/tenancy.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 15 tenancy tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createTenancyPlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No tenant data persists anywhere
in the base platform, since the default provider is in-process and lives only for the
lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds tenant definitions in-process only; removing the kernel
discards that in-memory state. If a real registry (PostgreSQL/Storage/Redis/MongoDB/cloud)
had been wired, tenant definitions live in that external system and are unaffected by
removing the kernel code — decommission it separately per its own runbook. Note that other
kernels' existing per-record `tenant` fields are unaffected — they are opaque labels, not
foreign keys into this kernel.
