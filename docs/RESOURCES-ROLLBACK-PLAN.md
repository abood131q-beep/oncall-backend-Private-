# Enterprise Resource Management Kernel — Rollback Plan (ADR-039)

The Resource Management Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-038) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/resources` or
  `src/domain/resources`. The kernel is only instantiated by an explicit
  `createResourcePlatform(...)` call, which the base platform does not make.
- **Inbound-only.** Call sites allocate through the port; no other kernel depends on the
  resource kernel, so removing it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/resources/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/resources/`
   - `src/application/resources/`
2. Delete the tests:
   - `tests/unit/resources.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-039-resource-management.md`
   - `docs/RESOURCES-DEVELOPER-GUIDE.md`, `docs/RESOURCES-PROVIDER-GUIDE.md`,
     `docs/RESOURCES-ROLLBACK-PLAN.md`
   - `docs/diagrams/resources-architecture.mermaid`,
     `docs/diagrams/resources-allocation-flow.mermaid`
4. Remove any composition-root call you added that wires `createResourcePlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/resources src/application/resources tests/unit/resources.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 14 resources tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createResourcePlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No resource or allocation data
persists anywhere in the base platform, since the default provider is in-process and lives
only for the lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds resource definitions + allocation state in-process only;
removing the kernel discards that in-memory state. If a real store (PostgreSQL/Storage/
Redis/MongoDB/cloud) had been wired, definitions + allocations live in that external system
and are unaffected by removing the kernel code — reconcile or decommission it separately per
its own runbook. Active allocations are simply forgotten in-process; the external store (if
any) retains the ledger for external reconciliation.
