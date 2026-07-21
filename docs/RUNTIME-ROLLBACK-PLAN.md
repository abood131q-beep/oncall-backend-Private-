# Enterprise Bootstrap Runtime — Rollback Plan (ADR-043)

The Bootstrap Runtime is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on the Composition Root (ADR-042) or any kernel
(ADR-016 … ADR-041). This document is the procedure to remove it and verify the removal is
inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/runtime`. A runtime exists only
  when application code calls `bootstrap(...)`; the base platform makes no such call.
- **Orchestrates, does not modify.** The runtime only *calls* `createPlatform` (ADR-042) and
  the platform's public API. It changes no kernel and no ADR-042 file. Removing it leaves
  the Composition Root and every kernel exactly as they were.
- **No shared state.** The runtime, supervisor, and context are per-bootstrap instances;
  there is no global singleton to unwind.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the runtime present, because importing it wires nothing.

## Procedure

1. Delete the runtime:
   - `src/runtime/`
2. Delete the tests:
   - `tests/unit/runtime.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-043-bootstrap-runtime.md`
   - `docs/RUNTIME-DEVELOPER-GUIDE.md`, `docs/RUNTIME-OPERATIONS-GUIDE.md`,
     `docs/RUNTIME-ROLLBACK-PLAN.md`, `docs/RUNTIME-VERIFICATION-REPORT.md`
   - `docs/diagrams/runtime-bootstrap.mermaid`, `docs/diagrams/runtime-lifecycle.mermaid`

```bash
rm -rf src/runtime tests/unit/runtime.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 21 runtime tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the runtime is only active when `bootstrap(...)` is called, leaving that call out
fully disables it without deleting code. The platform can still be composed directly via
`createPlatform(...)` (ADR-042), exactly as before.

## Data considerations

The runtime persists no data of its own. Each kernel's provider owns its data; injected
production providers are unaffected by removing the runtime and are decommissioned per their
own runbooks.
