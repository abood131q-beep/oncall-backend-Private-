# Enterprise Host Runtime — Rollback Plan (ADR-044)

The Host Runtime is strictly additive. Nothing in the platform imports it at runtime, so it
can be removed with zero effect on the Bootstrap Runtime (ADR-043), the Composition Root
(ADR-042), or any kernel (ADR-016 … ADR-041). This document is the procedure to remove it
and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/host`. A host exists only when
  application code calls `createHost(...)`; the base platform makes no such call.
- **Orchestrates, does not modify.** The host only *calls* the Runtime's public API and the
  hosted services' contract methods, and reuses ADR-042's dependency graph read-only. It
  changes no kernel, ADR-042, or ADR-043 file.
- **No shared state.** The host, registry, supervisor, and context are per-`createHost`
  instances; there is no global singleton to unwind.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the host present, because importing it wires nothing.

## Procedure

1. Delete the host runtime:
   - `src/host/`
2. Delete the tests:
   - `tests/unit/host.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-044-host-runtime.md`
   - `docs/HOST-DEVELOPER-GUIDE.md`, `docs/HOST-OPERATIONS-GUIDE.md`,
     `docs/HOST-ROLLBACK-PLAN.md`, `docs/HOST-VERIFICATION-REPORT.md`
   - `docs/diagrams/host-architecture.mermaid`,
     `docs/diagrams/host-service-lifecycle.mermaid`

```bash
rm -rf src/host tests/unit/host.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 21 host tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the host is only active when `createHost(...)` is called, leaving that call out
fully disables it without deleting code. The Runtime can still be bootstrapped and used
directly via `bootstrap(...)` (ADR-043), exactly as before.

## Data considerations

The host persists no data of its own. Hosted services own their own state and are stopped
via their `stop()` contract method on host shutdown; the underlying platform's kernel
providers are unaffected by removing the host and are decommissioned per their own runbooks.
