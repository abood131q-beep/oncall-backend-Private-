# Phase 17.2 — Platform Adapter Design

The `src/platform-adapters/` layer is the ONLY sanctioned boundary between the OnCall
application and the Enterprise Platform. In Phase 17.2 it is fully built, unit-tested, and
**inert** — no adapter consumes a kernel — so it changes zero behavior while establishing the
seam every later phase will use.

---

## 1. Rules (enforced by design + tests)

1. **Translation layers only** — adapters map shapes between the application and a kernel
   port. No business logic.
2. **No repository / DB / service access** — verified by a test asserting no adapter exposes
   a `repo|db|database|sqlite` surface (`tests/unit/platform-adapters.test.js`).
3. **Communicate only through an injected Enterprise public port** — an adapter never
   `require`s a kernel; it receives the kernel's public service as `port`.
4. **No application module imports a kernel** — routes, services, repositories, middleware,
   and `onCallApplication.js` import nothing under `src/platform`, `src/application/*`,
   `src/runtime`, or `src/host`. Only `src/platform-adapters/**` and `src/enterprise/**` may.
5. **Inert in 17.2** — constructed with `port = null`, so active (kernel-consuming) methods
   throw `AdapterNotWiredError`; only pure translators run.

## 2. Structure

```
src/platform-adapters/
  _base.js            AdapterNotWiredError + requirePort() guard
  configuration/      ↔ Config kernel (ADR-019)
  lifecycle/          ↔ Lifecycle kernel (ADR-040)
  observability/      ↔ Observability kernel (ADR-033)
  health/            → Host/Runtime health contract (pure; no kernel)
  jobs/               ↔ Jobs kernel (ADR-032)
  scheduler/          ↔ Scheduler kernel (ADR-020)
  identity/           ↔ Identity kernel (ADR-027)
  policy/             ↔ Policy kernel (ADR-025)
  audit/              ↔ Audit kernel (ADR-026)
  notification/       ↔ Notifications kernel (ADR-030)
  ratelimit/          ↔ Rate Limiting kernel (ADR-031)
  messaging/          ↔ Messaging kernel (ADR-024)
  index.js            createPlatformAdapters({ ports }) aggregator
```

## 3. Uniform adapter shape

Each adapter factory returns a frozen object:

```
{
  name,                       // adapter name
  kernel,                     // target kernel (ADR ref)
  consumed(),                 // false in 17.2 (true once a port is injected)
  <pureTranslator>(...),      // e.g. toPrincipal, toJob, toHostHealth — shape-only
  <activeMethod>(...),        // requires port; throws AdapterNotWiredError if inert
  health()                    // { ok:true, consumed:<bool> } — side-effect-free
}
```

Example (identity):

```js
toPrincipal({ phone, type, driverId }) →
  { subject: String(phone), kind: type, attributes: { driverId } }   // pure
verify(token) → requirePort('identity', port).verify(token)          // inert → throws
```

## 4. The aggregator — `createPlatformAdapters({ ports })`

Builds all 12 adapters, injecting `ports.<kernel>` where present (empty in 17.2). Exposes:
`list()`, `consumed()` (empty in 17.2), `layerHealth()` (`{ total:12, consumed:0, … }`),
`describe()`.

> Naming note: the layer's aggregate reporter is `layerHealth()`, deliberately **not**
> `health()`, so the spread `health` **adapter** (`adapters.health`) is not shadowed. This
> collision was found and fixed during implementation via the injected-fake lifecycle test.

## 5. How a future phase consumes one kernel (illustrative — NOT done in 17.2)

```js
// e.g. adopting Config only:
const adapters = createPlatformAdapters({ ports: { config: platform.getKernel('config') } });
adapters.consumed();            // → ['configuration']
adapters.configuration.get(k);  // now delegates to the Config kernel port
```

One concern flips at a time, behind its own flag, gated by the A/B harness — exactly the
reversible pattern from the Phase 17.1 roadmap. Until then, the seam stays inert and behavior
stays identical.

## 6. Why inert-but-present

Building the whole seam now (a) proves the boundary compiles and is uniform, (b) gives every
future migration a ready, tested target with no per-phase scaffolding, and (c) guarantees —
by construction and by test (`consumed() === []`) — that Phase 17.2 introduces no kernel
coupling and therefore no behavior change.
