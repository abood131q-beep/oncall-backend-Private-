# Enterprise Deployment Runtime — Developer Guide (ADR-045)

The Deployment Runtime orchestrates deployment, version rollout, rollback, verification,
and release strategies for services hosted by the Host Runtime (ADR-044). It is **not a
kernel, not a CI/CD system, not Kubernetes**. It lives under `src/deployment/`, strictly
additive, and drives everything through the host's public API.

## 1. Production deployment (the whole thing)

```js
const { bootstrap } = require('../../src/runtime');
const { createHost } = require('../../src/host');
const { createDeployment } = require('../../src/deployment');

const runtime = await bootstrap(config);
const host = await createHost({ runtime });
const deployment = await createDeployment({ host });

await deployment.deploy({ service: apiGatewayService, strategy: 'rolling' });
await deployment.verify();
```

`createDeployment({ host })` requires an existing Host Runtime. It manages deployments for
that host's services.

## 2. The deployment contract (§2)

```js
await deployment.deploy(request);   // plan → strategy → verify (auto-rollback on failure)
await deployment.rollback(opts);    // auto | manual | partial | full
await deployment.verify();          // re-verify the current deployment
deployment.status();                // supervisor snapshot + all deployment records
deployment.history(serviceId?);     // deployment history (per service or all)
deployment.version();               // current deployed version
deployment.metadata();              // environment, version, available strategies
await deployment.health();          // deployment health (see §9)
```

## 3. Release strategies (§3 — deterministic, interchangeable)

```js
await deployment.deploy({ service, strategy: 'immediate' });   // deploy + verify once
await deployment.deploy({ service, strategy: 'rolling', params: { waves: 3 } });
await deployment.deploy({ service, strategy: 'blue-green' });  // green up, verify, switch
await deployment.deploy({ service, strategy: 'canary', params: { stages: [10, 50, 100] } });
```

Inject a custom strategy (DI):

```js
await deployment.deploy({
  service,
  strategy: {
    name: 'my-strategy',
    execute: async ({ service, ops, descriptor, clock }) => {
      await ops.deploy(service);
      return { ok: true, strategy: 'my-strategy', steps: [{ step: 'go', at: clock(), ok: true }], version: descriptor.version };
    },
  },
});
```

A strategy drives the `ops` facade (`deploy`, `health`, `undeploy`) only — never the host
or kernels directly.

## 4. The planner (§4 — generates, never executes)

```js
const { createDeploymentPlanner } = require('../../src/deployment');
const planner = createDeploymentPlanner({ host });
const plan = await planner.plan({ service, version: '2.0.0', strategy: 'rolling', contractId });
// { service, version, strategy, deployOrder, rollbackOrder, checks:{
//     dependencies, deploymentOrder, rollbackOrder, versionCompatibility, resourceAvailability }, ok }
```

`deploy()` runs the planner first and aborts with `DeploymentPlanError` if the plan is
invalid (e.g. a missing dependency). Version compatibility is checked against the
Compatibility Kernel (ADR-041) when a `contractId` is provided; resource availability
against the Resource Kernel (ADR-039) when present.

## 5. Rollback (§5)

```js
await deployment.rollback({ mode: 'full' });                 // revert all, reverse order
await deployment.rollback({ mode: 'partial', services: ['api'] });
await deployment.rollback({ mode: 'manual', services: ['api'] });
await deployment.rollback({ deploymentId });                  // a specific record
```

Rollback restores the retained previous version of a service (or undeploys it if there is
none) through the host, and verifies the result. Blue-green/canary retain the prior version
so rollback re-activates it.

## 6. Verification (§8)

`deploy()` verifies before declaring success: deployment plan completed, host healthy,
runtime healthy, all services healthy, compatibility passed, strategy completed. On failure
the deployment auto-rolls-back (unless `autoRollback: false`) and throws.

## 7. Health (§9)

```js
const h = await deployment.health();
// { status, deployment: {state, strategy, ...}, activeDeployment,
//   currentReleaseStrategy, rollbackReadiness: { ready, services }, verificationState, host }
```

## Determinism & isolation

- **Deterministic** — the same service + strategy + params always yields the same ordered
  steps; the injected clock drives timing only.
- **Interchangeable strategies** — selected by name or injected; the deploy flow is
  strategy-agnostic.
- **Thin & delegating** — planning reuses ADR-042's graph; rollout/rollback go through the
  host (ADR-044 → ADR-043 → ADR-040).
- **Additive** — importing `src/deployment` instantiates nothing; a deployment runtime
  exists only after `createDeployment(...)`.
