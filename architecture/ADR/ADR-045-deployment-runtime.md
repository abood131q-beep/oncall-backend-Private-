# ADR-045 — Enterprise Deployment Runtime

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 16.4 · **Sits above:** ADR-044 (Host Runtime). **Uses:** ADR-042's dependency
graph for plan ordering; delegates lifecycle transitively to ADR-044 → ADR-043 → ADR-040;
consults ADR-041 (Compatibility) and ADR-039 (Resources) when available.

## Context

The Host Runtime (ADR-044) can host and manage services under one platform, but it has no
notion of *how a service is rolled out* — deploying a new version, choosing a release
strategy, verifying the result, and rolling back on failure. Without a deployment layer,
each operator would script rollout and rollback by hand, with no deterministic plan, no
strategy abstraction, and no uniform verification.

This ADR introduces the **Enterprise Deployment Runtime** under `src/deployment/`. It owns
deployment orchestration, version rollout, rollback, deployment verification, and release
strategies for hosted services. It is explicitly **not a Kernel**, **not a CI/CD system**,
and **not Kubernetes**. It never modifies any kernel, ADR-042, ADR-043, or ADR-044; it
drives everything through the Host Runtime's public API.

Production deployment becomes:

```js
import { bootstrap } from './runtime';
import { createHost } from './host';
import { createDeployment } from './deployment';
const runtime = await bootstrap(config);
const host = await createHost({ runtime });
const deployment = await createDeployment({ host });
await deployment.deploy({ service: apiGatewayService, strategy: 'rolling' });
await deployment.verify();
```

## Decision

Add `src/deployment/` with eleven files, all additive:

- **`errors.js`** — the deployment error model (`DeploymentStateError`,
  `DeploymentContractError`, `DeploymentPlanError`, `ReleaseStrategyError`,
  `DeploymentExecutionError`, `RollbackError`, `DeploymentVerificationError`).
- **`deploymentContext.js`** — one immutable deployment context (host, runtime, platform,
  configuration, logger, metrics, environment, version, deployment metadata). `scopeFor`
  gives each component only the dependencies it declares.
- **`deploymentRegistry.js`** — per-runtime registry of deployment records with per-service
  history + current, and `register/update/unregister/resolve/list/current/history/verify`.
- **`releaseStrategy.js`** — the four deterministic, interchangeable strategies
  (`immediate`, `rolling`, `blue-green`, `canary`), selectable by name or injected as a
  custom `{ name, execute }` (DI). A strategy drives an injected `ops` facade only.
- **`deploymentPlanner.js`** — generates + validates plans (service dependencies,
  deployment order, rollback order, version compatibility, resource availability) and
  **never executes** them. Ordering reuses ADR-042's dependency graph.
- **`rollbackManager.js`** — automatic, manual, partial, and full rollback + rollback
  verification, restoring prior versions through the host (reusing ADR-040 lifecycle
  transitively).
- **`deploymentVerifier.js`** — confirms plan completed, host healthy, runtime healthy, all
  services healthy, compatibility passed, and strategy completed (§8).
- **`deploymentSupervisor.js`** — monitors deployment/verification/rollback state, active
  strategy, duration, and failure count. No business logic.
- **`deployment.js`** — the Deployment object: the §2 contract (`deploy`, `rollback`,
  `verify`, `status`, `history`, `version`, `metadata`) plus `health()`.
- **`deploymentBuilder.js`** — exposes ONLY `createDeployment(options)`.
- **`index.js`** — the public entry point.

**Deploy flow:** plan (validate; abort if invalid) → execute the injected release strategy
via the `ops` facade → verify (§8) → on failure, automatic rollback (unless disabled) →
record the deployment. Everything is deterministic and driven through the host's public
API; the deployment layer touches no kernel internals.

## Alternatives rejected

- **Baking rollout into the Host Runtime** — rejected: the host manages *running* services;
  *how* a version is rolled out and verified is a separate concern with its own strategies.
- **A real CI/CD / Kubernetes integration** — rejected: out of scope. This is an in-process
  orchestration layer over the host; external systems can call it, not the reverse.
- **Strategies hard-coded in the deploy method** — rejected: strategies are injected and
  interchangeable, so new strategies need no change to the deploy flow.
- **Planner that executes** — rejected: the planner only generates + validates; execution is
  the release strategy's job, keeping plan generation pure and testable.
- **Re-implementing lifecycle/rollback ordering** — rejected: rollback restores services
  through the host, whose start/stop delegate to ADR-043 → ADR-040.

## Consequences

- New files under `src/deployment/**` and `tests/unit/deployment.test.js` (+24 tests). Zero
  hot-path change; importing the module wires nothing until `createDeployment(...)` runs, so
  all ten application A/B harnesses stay byte-identical.
- Deployments are recorded with history; redeploying a service replaces it and retains the
  prior version for rollback. Verification failures trigger automatic rollback by default.

## Rollback

Delete `src/deployment/` and `tests/unit/deployment.test.js`. Nothing else imports them, so
removal is inert and ADR-044, ADR-043, ADR-042, and every kernel (ADR-016 … ADR-041) are
unchanged. See `docs/DEPLOYMENT-ROLLBACK-PLAN.md`.
