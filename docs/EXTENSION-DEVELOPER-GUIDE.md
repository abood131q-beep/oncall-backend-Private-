# OnCall Extension Developer Guide (Phase 14.2)

Extensions add capabilities and react to lifecycle events **without modifying platform
code**. They talk to the platform only through granted Ports, run isolated, and are
hot-pluggable. This guide shows how to build, package, and ship one.

## 1. Anatomy

An extension package is:

```js
{
  manifest,                 // validated descriptor (see §2)
  bytes?, checksum?, signature?,   // optional integrity material (§5)
  register(ctx, api) { … }  // wires capabilities/hooks; returns optional teardown()
}
```

- `ctx` — the **sandbox context**: an object exposing ONLY the ports whose permission you
  declared AND the host granted. Anything else is `undefined` (deny-all).
- `api.registerHook(hook, fn)` — subscribe to a lifecycle hook.
- `api.manifest` — your validated manifest.
- return a `teardown()` (sync/async) to release resources on disable/unload.

## 2. Manifest (all fields validated; invalid ⇒ rejected)

```jsonc
{
  "id": "surge-pricing",              // ^[a-z][a-z0-9-]{2,63}$
  "name": "Surge Pricing",
  "version": "1.2.0",                 // semver
  "apiVersion": "1.0.0",              // must satisfy the platform's accepted range
  "author": "OnCall Labs",
  "description": "Dynamic surge within authored bounds",
  "permissions": ["read:pricing", "write:pricing"],   // closed vocabulary
  "capabilities": ["RidePricing"],                      // closed vocabulary
  "dependencies": { "geo-zones": "^1.0.0" },            // id: semver range
  "minimumPlatformVersion": "1.0.0",
  "compatibilityRules": {},
  "lifecycleHooks": ["BeforeRideRequest"],              // closed vocabulary
  "configurationSchema": {},
  "healthChecks": [{ "name": "model-loaded" }]
}
```

**Capabilities:** RidePricing, PaymentProvider, VehicleProvider, NotificationProvider,
TelemetryProvider, IdentityProvider, StorageProvider, AIProvider, MapsProvider,
DispatchProvider.

**Permissions:** read:trips, read:users, read:drivers, read:vehicles, read:pricing,
write:pricing, read:config, publish:events, subscribe:events, net:outbound, storage:read,
storage:write, secrets:read.

**Hooks:** BeforeRideRequest, AfterRideCreated, BeforePayment, AfterPayment, BeforeUnlock,
AfterUnlock, TripStarted, TripCompleted, DriverApproved, ScooterReturned, UserRegistered,
OrganizationCreated. `Before*` hooks may return `{ cancel: true, reason }` to veto a flow;
all others are observational.

## 3. Example — see `docs/examples/surge-pricing-extension.js`.

## 4. Lifecycle (no restart)

```
install → enable ⇄ disable → upgrade → (rollback) → uninstall
                        └── reload / unload ──┘
```

Install runs the security gate (manifest validation + checksum + signature + compatibility).
Enable builds your sandbox and calls `register`. Disable/unload removes your hooks and runs
`teardown`. Upgrade preserves the prior version so `rollback` can restore it.

## 5. Security & isolation (what you can rely on)

- **Deny-all sandbox** — you only get ports you declared and were granted.
- **Isolation** — if your hook throws or exceeds the timeout, the platform proceeds
  (fail-open) and other extensions are unaffected. Repeated failures **open a circuit
  breaker** that skips your handler until it cools down.
- **Integrity** — ship `checksum` (sha256) and, where signing is required, a `signature`
  verifiable by the host's configured verifier.

## 6. Observability

The host exposes per-extension execution count, failure rate, average latency, load time,
and health, including a Prometheus exposition — no work needed from you beyond registering.

## 7. Migration note

Existing platform behavior is untouched by this platform. To move logic into an extension,
add a capability/hook here and adopt it behind a flag — never edit the working module.
