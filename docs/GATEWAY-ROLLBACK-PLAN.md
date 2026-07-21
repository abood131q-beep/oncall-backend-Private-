# Enterprise API Gateway Kernel — Rollback Plan (ADR-035)

The API Gateway Kernel is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-034) or the
application. This document is the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/gateway` or
  `src/domain/gateway`. The kernel is only instantiated by an explicit
  `createGatewayPlatform(...)` call, which the base platform does not make.
- **Integration is inbound-only.** The gateway calls other kernels through injected ports
  (`deps.ports`); no other kernel depends on the gateway, so removing it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/gateway/events.js`);
  the shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/gateway/`
   - `src/application/gateway/`
2. Delete the tests:
   - `tests/unit/gateway.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-035-api-gateway.md`
   - `docs/GATEWAY-DEVELOPER-GUIDE.md`, `docs/GATEWAY-PROVIDER-GUIDE.md`,
     `docs/GATEWAY-ROLLBACK-PLAN.md`
   - `docs/diagrams/gateway-architecture.mermaid`, `docs/diagrams/gateway-routing-flow.mermaid`
4. Remove any composition-root call you added that wires `createGatewayPlatform(...)` (the
   base platform has none).

```bash
rm -rf src/domain/gateway src/application/gateway tests/unit/gateway.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 19 gateway tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createGatewayPlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No route data persists anywhere in
the base platform, since the default provider + cache are in-process and live only for the
lifetime of an instantiated kernel. Individual enforcement steps can also be disabled simply
by not injecting the corresponding kernel port.

## Data considerations

The default memory provider holds route definitions in-process only; removing the kernel
discards that in-memory state. If a real gateway backend (Kong/Envoy/NGINX/cloud) had been
wired, route config lives in that external system and is unaffected by removing the kernel
code — decommission it separately per its own runbook. The route cache is purely in-memory
and derived from the route table, so it needs no migration.
