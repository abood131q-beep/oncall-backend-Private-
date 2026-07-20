# Enterprise Secrets Kernel — Rollback Plan (ADR-028)

The Secrets Kernel is strictly additive. Nothing in the platform imports it at runtime, so
it can be removed with zero effect on any prior kernel (ADR-016 … ADR-027) or the
application. This document is the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/secrets` or
  `src/domain/secrets`. The kernel is only instantiated by an explicit
  `createSecretsPlatform(...)` call, which the base platform does not make.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present, proving it adds no observable behavior to existing contracts.
- **Self-contained.** The domain event catalog is local (`src/domain/secrets/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/secrets/`
   - `src/application/secrets/`
2. Delete the tests:
   - `tests/unit/secrets.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-028-secrets.md`
   - `docs/SECRETS-DEVELOPER-GUIDE.md`, `docs/SECRETS-PROVIDER-GUIDE.md`,
     `docs/SECRETS-ROLLBACK-PLAN.md`
   - `docs/diagrams/secrets-architecture.mermaid`, `docs/diagrams/secrets-lifecycle.mermaid`
4. Remove any composition-root call you added that wires `createSecretsPlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/secrets src/application/secrets tests/unit/secrets.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 18 secrets tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createSecretsPlatform(...)` is called, a feature
flag at the composition root is sufficient to disable it without deleting code: simply do
not call the factory. No secret data persists anywhere in the base platform, since the
default provider is in-process and lives only for the lifetime of an instantiated kernel.

## Data considerations

The default memory provider holds secrets in-process only; removing the kernel discards
that in-memory state. If a real provider (Vault/AWS/Azure/GCP) had been wired, secret data
lives in that external store and is unaffected by removing the kernel code — decommission
the external store separately per its own runbook.
