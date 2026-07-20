# Enterprise Policy Engine — Developer Guide (ADR-025)

The Policy Kernel evaluates decisions consistently across the platform. It is **not an
authorization framework**, **not a rule engine**, and **not tied to OPA/Cedar/Casbin** — it is
a small, deterministic, framework-free decision engine. Decisions default to **deny**.

## 1. Compose

```js
const { createPolicyPlatform } = require('../../src/application/policy');
const pol = createPolicyPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  strategy: 'deny-overrides', // default conflict-resolution strategy
});
const P = pol.policy;
```

## 2. Register a policy

```js
await P.register({
  name: 'allow-vip',
  scope: 'trip:create', // what this policy governs ("*" = all scopes)
  effect: 'allow', // 'allow' | 'deny'  (default 'deny')
  priority: 10, // higher = considered first
  namespace: 'default',
  condition: { field: 'user.tier', op: 'eq', value: 'vip' },
});
```

Conditions are data (or a custom `fn`): leaf `{ field, op, value }` with operators
`eq, ne, gt, gte, lt, lte, in, nin, contains, exists, regex`, composed with `all` / `any` /
`not`. `field` is a dotted path into the evaluation context.

## 3. Evaluate

```js
const d = await P.evaluate({ scope: 'trip:create', user: { tier: 'vip' }, hour: 12 });
// → { allowed: true, decision: 'allow', reason, decidingPolicy }

const full = await P.explain({ scope: 'trip:create', user: { tier: 'vip' }, hour: 23 });
// → adds `evaluated: [{ policyId, name, effect, applicable, error }]` (uncached, full trace)
```

The `request` is `{ namespace?, scope, ...context }`. Only policies whose `scope` matches
(equal or `*`) and whose condition holds are applicable.

## 4. Conflict resolution

Strategy (per-evaluate override via `opts.strategy`):

- **deny-overrides** (default) — any applicable deny wins; else any allow; else default deny.
- **allow-overrides** — any applicable allow wins; else any deny; else default deny.
- **first-applicable** — the first applicable policy (priority order) decides.
- **priority** — the highest-priority applicable policy decides.

Policies are ordered by priority DESC then policyId ASC (stable), so evaluation is
deterministic.

## 5. Lifecycle

```js
P.enable('default', policyId);
P.disable('default', policyId); // removed from evaluation, kept as a definition
P.list({ namespace: 'default', scope: 'trip:create', state: 'enabled' });
P.verify('default'); // integrity: recompute + compare each policy checksum
await P.health();
```

## 6. Events (through the port only)

`PolicyRegistered`, `PolicyUpdated`, `PolicyEnabled`, `PolicyDisabled`, `PolicyEvaluated`,
`PolicyRejected` — all via the Event Backbone, producer `policy`. The EventBus is never
exposed.

## 7. Observability

```js
pol.metrics.snapshot(); // registered, evaluated, allow/deny, latency, cache hit/miss
pol.metrics.prometheus();
```

Repeated evaluations of the same request are served from a decision cache (invalidated on any
policy change).

## 8. SDK integration (ADR-018)

```js
const { toPolicyPort } = require('../../src/application/policy/sdkAdapter');
const portFactories = {
  'policy:read': () => toPolicyPort(pol.policy, { owner: extId, canEvaluate: false }),
  'policy:evaluate': () => toPolicyPort(pol.policy, { owner: extId }),
};
// Inside the extension: this.policy().evaluate({ scope: 'x', ...ctx })
```

Every request/registration is forced into the extension's namespace (`ext.<owner>`), so an
extension can only author and evaluate its own policies. `register/enable/disable/list`
require `policy:read`; `evaluate/explain` require `policy:evaluate`.

## Out of scope (future work behind the provider port)

External policy runtimes (OPA/Cedar/Casbin) as definition stores, and distributed policy
distribution — declared extension points, not implemented in this phase.
