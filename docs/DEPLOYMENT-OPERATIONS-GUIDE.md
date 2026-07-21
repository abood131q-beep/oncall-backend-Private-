# Enterprise Deployment Runtime — Operations Guide (ADR-045)

This guide is for operators rolling out and rolling back hosted services via the Deployment
Runtime, which sits directly above the Host Runtime (ADR-044).

## Deploying a service

```js
const deployment = await createDeployment({ host });
const result = await deployment.deploy({
  service: apiGatewayService,
  strategy: 'rolling',        // immediate | rolling | blue-green | canary
  version: '2.0.0',           // optional; defaults to service.version()
  contractId: 'api-gateway',  // optional; enables Compatibility Kernel version check
  params: { waves: 3 },       // strategy-specific
});
```

`deploy()` runs in strict order: **plan → strategy → verify**. It refuses to start if the
plan is invalid (`DeploymentPlanError`, e.g. a missing service dependency) and it
auto-rolls-back if the rollout or verification fails. A successful result includes the
plan, the ordered strategy steps, and the verification checks.

## Choosing a release strategy

- **immediate** — deploy once, verify once. Lowest ceremony; use for stateless internal
  services.
- **rolling** — deploy, then verify across N deterministic waves (`params.waves`). Use for
  services where you want staged health confirmation.
- **blue-green** — bring up the new version ("green"), verify it, switch; the prior version
  ("blue") is retained for instant rollback.
- **canary** — deploy, then verify at each deterministic stage (`params.stages`, default
  `[10, 50, 100]`). Use for high-risk changes.

Strategies are interchangeable — switching is a one-word change, and custom strategies can
be injected.

## Verifying a deployment

```js
const v = await deployment.verify();
// checks: planCompleted, hostHealthy, runtimeHealthy, allServicesHealthy,
//         compatibilityPassed, strategyCompleted
```

`deploy()` already verifies before returning success; call `verify()` again any time to
re-confirm the current deployment's health.

## Rolling back

```js
await deployment.rollback({ mode: 'full' });                    // revert everything, reverse order
await deployment.rollback({ mode: 'partial', services: ['api'] });
await deployment.rollback({ deploymentId });                    // a specific deployment
```

Modes: `full` (all deployed services, reverse order), `partial`/`manual` (named services),
`auto` (triggered internally on deploy failure). Rollback restores the retained prior
version through the host and verifies the result; a failed rollback throws `RollbackError`
(except in `auto` mode, which records and continues).

## Health & monitoring

```js
const h = await deployment.health();
h.status;                     // 'healthy' | 'degraded' | 'failed'
h.activeDeployment;           // { id, service, version, status, strategy }
h.currentReleaseStrategy;     // last strategy used
h.rollbackReadiness.ready;    // whether a rollback can be performed now
h.verificationState;          // 'passed' | 'failed' | null
deployment.status().supervisor; // state, duration, failureCount, recent failures
deployment.history('api');    // per-service deployment history
```

Alert on `status !== 'healthy'`, on `deployment.status().supervisor.failureCount` rising,
and on `verificationState === 'failed'`.

## Failure handling

- `DeploymentPlanError` — the plan failed validation; nothing was deployed. Inspect
  `err.details` (missing dependencies, order, version/resource checks).
- `DeploymentExecutionError` — the release strategy failed mid-rollout; an automatic
  rollback was attempted.
- `DeploymentVerificationError` — post-deploy verification failed; an automatic rollback was
  attempted.
- `RollbackError` — a rollback could not complete or failed verification.
- `ReleaseStrategyError` — an unknown strategy name was requested.

Set `autoRollback: false` on `deploy()` to leave a failed deployment in place for manual
inspection (the supervisor state will be `failed`).

## What the deployment runtime does NOT do

It runs no business logic, defines no kernels, and modifies no kernel, ADR-042, ADR-043, or
ADR-044. It is not a CI/CD pipeline and not Kubernetes — it is an in-process orchestration
layer that drives the Host Runtime's public API.
