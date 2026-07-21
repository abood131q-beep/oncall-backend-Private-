# Enterprise Platform Composition Root — Rollback Plan (ADR-042)

The Composition Root is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on any kernel (ADR-016 … ADR-041) or the
application. This document is the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/platform`. A runtime exists
  only when application code calls `createPlatform(...)`; the base platform makes no such
  call.
- **Composes, does not modify.** The composition root only *calls* each kernel's existing
  `create*Platform(...)` factory via DI. It changes no kernel file, no kernel public API,
  and no kernel port. Removing it leaves every kernel exactly as it was.
- **No shared state.** The registry and context are per-platform and closure-scoped; there
  is no global singleton to unwind.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the composition root present, because importing it wires nothing.

## Procedure

1. Delete the composition root:
   - `src/platform/`
2. Delete the tests:
   - `tests/unit/platform.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-042-platform-composition-root.md`
   - `docs/PLATFORM-DEVELOPER-GUIDE.md`, `docs/PLATFORM-ARCHITECTURE-GUIDE.md`,
     `docs/PLATFORM-ROLLBACK-PLAN.md`, `docs/PLATFORM-VERIFICATION-REPORT.md`
   - `docs/diagrams/platform-composition.mermaid`,
     `docs/diagrams/platform-dependency-graph.mermaid`

```bash
rm -rf src/platform tests/unit/platform.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 24 platform tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the composition root is only active when `createPlatform(...)` is called, leaving
that call out fully disables it without deleting code. Individual kernels can still be
composed directly via their own `create*Platform(...)` factories, exactly as before.

## Data considerations

The composition root persists no data of its own. Each kernel's provider owns its data; if
production providers were injected via `kernelOptions`, they are unaffected by removing the
composition root and are decommissioned per their own runbooks.
