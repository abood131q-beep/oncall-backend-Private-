# Enterprise Rate Limiting Kernel — Rollback Plan (ADR-031)

The Rate Limiting Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-030) or
the application. This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/ratelimit` or
  `src/domain/ratelimit`. The kernel is only instantiated by an explicit
  `createRateLimitPlatform(...)` call, which the base platform does not make.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present, proving it adds no observable behavior to existing contracts.
- **Self-contained.** The domain event catalog is local (`src/domain/ratelimit/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/ratelimit/`
   - `src/application/ratelimit/`
2. Delete the tests:
   - `tests/unit/ratelimit.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-031-rate-limiting.md`
   - `docs/RATELIMIT-DEVELOPER-GUIDE.md`, `docs/RATELIMIT-PROVIDER-GUIDE.md`,
     `docs/RATELIMIT-ROLLBACK-PLAN.md`
   - `docs/diagrams/ratelimit-architecture.mermaid`,
     `docs/diagrams/ratelimit-evaluation-flow.mermaid`
4. Remove any composition-root call you added that wires `createRateLimitPlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/ratelimit src/application/ratelimit tests/unit/ratelimit.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 19 ratelimit tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createRateLimitPlatform(...)` is called, a feature
flag at the composition root is sufficient to disable it without deleting code: simply do
not call the factory. No quota data persists anywhere in the base platform, since the
default provider + cache are in-process and live only for the lifetime of an instantiated
kernel.

## Data considerations

The default memory provider holds policies + counters in-process only; removing the kernel
discards that in-memory state. If a real counter store (Redis/Storage/PostgreSQL/MongoDB)
had been wired, that data lives in the external system and is unaffected by removing the
kernel code — decommission it separately per its own runbook. The usage cache is purely
in-memory and derived from counters, so it needs no migration.
