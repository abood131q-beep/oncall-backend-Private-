# Enterprise Service Mesh Kernel — Rollback Plan (ADR-037)

The Service Mesh Kernel is strictly additive. Nothing in the platform imports it at runtime,
so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-036) or the
application. This document is the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/mesh` or
  `src/domain/mesh`. The kernel is only instantiated by an explicit `createMeshPlatform(...)`
  call, which the base platform does not make.
- **Integration is inbound-only.** The mesh calls other kernels through injected ports
  (`deps.ports`); no other kernel depends on the mesh, so removing it cannot affect them.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present.
- **Self-contained.** The domain event catalog is local (`src/domain/mesh/events.js`); the
  shared platform event catalog is untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/mesh/`
   - `src/application/mesh/`
2. Delete the tests:
   - `tests/unit/mesh.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-037-service-mesh.md`
   - `docs/MESH-DEVELOPER-GUIDE.md`, `docs/MESH-PROVIDER-GUIDE.md`, `docs/MESH-ROLLBACK-PLAN.md`
   - `docs/diagrams/mesh-architecture.mermaid`, `docs/diagrams/mesh-invocation-flow.mermaid`
4. Remove any composition-root call you added that wires `createMeshPlatform(...)` (the base
   platform has none).

```bash
rm -rf src/domain/mesh src/application/mesh tests/unit/mesh.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 17 mesh tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createMeshPlatform(...)` is called, leaving the
factory uncalled fully disables it without deleting code. No connection data persists
anywhere in the base platform, since the default provider is in-process and lives only for
the lifetime of an instantiated kernel. Individual enforcement steps can also be disabled by
not injecting the corresponding kernel port.

## Data considerations

The default memory provider holds connection definitions in-process only; removing the
kernel discards that in-memory state. If a real mesh backend (Istio/Linkerd/Consul/cloud)
had been wired, connection config lives in that external system and is unaffected by
removing the kernel code — decommission it separately per its own runbook.
