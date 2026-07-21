# Enterprise Resilience Kernel — Rollback Plan (ADR-036)

The Resilience Kernel is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-035) or the
application. This document is the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/resilience` or
  `src/domain/resilience`. The kernel is only instantiated by an explicit
  `createResiliencePlatform(...)` call, which the base platform does not make.
- **Inbound-only.** Call sites hand the kernel a plain `fn` via `execute()`; no other kernel
  depends on the resilience kernel, so removing it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/resilience/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/resilience/`
   - `src/application/resilience/`
2. Delete the tests:
   - `tests/unit/resilience.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-036-resilience.md`
   - `docs/RESILIENCE-DEVELOPER-GUIDE.md`, `docs/RESILIENCE-PROVIDER-GUIDE.md`,
     `docs/RESILIENCE-ROLLBACK-PLAN.md`
   - `docs/diagrams/resilience-architecture.mermaid`,
     `docs/diagrams/resilience-execution-flow.mermaid`
4. Remove any composition-root call you added that wires `createResiliencePlatform(...)`
   (the base platform has none).

```bash
rm -rf src/domain/resilience src/application/resilience tests/unit/resilience.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 20 resilience tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createResiliencePlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No policy or circuit data persists
anywhere in the base platform, since the default provider is in-process and lives only for
the lifetime of an instantiated kernel. Individual protected call sites simply invoke their
`fn` directly if the kernel is not wired.

## Data considerations

The default memory provider holds policies + circuit state in-process only; removing the
kernel discards that in-memory state. If a real store (Redis/PostgreSQL/Storage/MongoDB) had
been wired, policy + circuit state lives in that external system and is unaffected by
removing the kernel code — decommission it separately per its own runbook. Circuit state is
transient and self-heals from the closed state, so it needs no migration.
