# Enterprise Deployment Runtime — Rollback Plan (ADR-045)

The Deployment Runtime is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on the Host Runtime (ADR-044), the Bootstrap Runtime
(ADR-043), the Composition Root (ADR-042), or any kernel (ADR-016 … ADR-041). This document
is the procedure to remove it and verify the removal is inert.

(Note: this is the *code rollback* plan for the deployment runtime module itself — distinct
from the runtime's own `rollback()` feature, which reverts a service deployment.)

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/deployment`. A deployment
  runtime exists only when application code calls `createDeployment(...)`; the base platform
  makes no such call.
- **Orchestrates, does not modify.** It drives only the Host Runtime's public API and reuses
  ADR-042's dependency graph read-only. It changes no kernel, ADR-042, ADR-043, or ADR-044
  file.
- **No shared state.** The deployment runtime, registry, and supervisor are per-
  `createDeployment` instances; there is no global singleton to unwind.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the deployment runtime present, because importing it wires nothing.

## Procedure

1. Delete the deployment runtime:
   - `src/deployment/`
2. Delete the tests:
   - `tests/unit/deployment.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-045-deployment-runtime.md`
   - `docs/DEPLOYMENT-DEVELOPER-GUIDE.md`, `docs/DEPLOYMENT-OPERATIONS-GUIDE.md`,
     `docs/DEPLOYMENT-ROLLBACK-PLAN.md`, `docs/DEPLOYMENT-VERIFICATION-REPORT.md`
   - `docs/diagrams/deployment-architecture.mermaid`,
     `docs/diagrams/deployment-release-flow.mermaid`

```bash
rm -rf src/deployment tests/unit/deployment.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 24 deployment tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the deployment runtime is only active when `createDeployment(...)` is called,
leaving that call out fully disables it without deleting code. Services can still be hosted
directly via `createHost(...)` (ADR-044), exactly as before.

## Data considerations

The deployment runtime persists no data of its own; its registry of deployment records is
in-process and discarded on removal. Hosted services and the underlying platform's kernel
providers are unaffected and are decommissioned per their own runbooks.
