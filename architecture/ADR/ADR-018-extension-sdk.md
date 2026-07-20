# ADR-018 — Enterprise Extension SDK

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.3.1 · **Depends on:** ADR-016 (Event Backbone), ADR-017 (Extension Platform)

## Context

ADR-017 delivered the Extension Platform (registry, sandbox, hookBus, metrics, resolver).
Building an extension against it still required hand-authoring a manifest, keeping
`capabilities`/`lifecycleHooks` in sync with the code, computing checksums, and writing a
`register(ctx, api)` block. That boilerplate is error-prone and would fragment as the
extension ecosystem grows over a 10-year horizon. We need one official, framework-style SDK
that becomes the **only supported** way to build extensions.

## Decision

Add a self-contained, additive SDK at `src/sdk/extensions`. It is imported by **no hot
path**; it produces the *same* `{ manifest, bytes, checksum, register(ctx, api) }` package
the Phase-14.2 registry already consumes, so the platform runs byte-identically and existing
raw extensions keep working.

**`Extension` base class** — a subclass declares identity in `super({...})` and uses:

- **Lifecycle** (all optional): `onInstall`, `onEnable`, `onDisable`, `onUnload`,
  `onHealthCheck`, `onConfigurationChanged`.
- **Hook API**: one clean method per catalog hook (`beforeRideRequest`, `afterPayment`, …),
  generated from `hooksCatalog`. No registry internals; handlers are flushed to
  `api.registerHook` at enable.
- **Capability API**: `providesCapability(name)`, validated against the closed vocabulary.
- **Configuration API**: `config()`, `reloadConfig()`, `validateConfig()` — defaults, type,
  and required-key checks; never exposes platform internals.
- **Logger API**: `logger.{info,warn,error,debug}` auto-enriched with extension id, version,
  correlation id, and timestamp.
- **Event API**: `publish()` / `subscribe()` through the granted EventPublisher **port**
  only — no direct EventBus.
- **Health API**: `healthy()/degraded()/failed()/notReady()`.
- `toPackage()` derives `capabilities` + `lifecycleHooks`, validates the manifest
  (`ManifestError` on failure), and computes the checksum.

**Standard error model** — `ExtensionError` base + `ConfigurationError`, `CapabilityError`,
`PermissionError`, `HookRegistrationError`, and the re-exported `ManifestError` (one manifest
error type platform-wide).

**Testing kit** — `harness()` drives an extension through its full lifecycle without booting
the platform, using the **real** hookBus for faithful isolation/timeout/veto semantics, plus
`createMockContext/Ports/Events/Config/Logger`.

## Alternatives rejected

- **Decorators / TypeScript metadata** — rejected: the platform is plain Node CommonJS; a
  runtime, dependency-free class API keeps the SDK usable everywhere without a build step.
- **Codegen from manifest files** — rejected: adds a build stage and drifts from code; the
  SDK derives the manifest *from* the code instead.
- **Letting the SDK reach the registry/EventBus directly** — rejected: violates Ports &
  Adapters. The SDK wires only through `api.registerHook` and granted ports.

## Consequences

- New: `src/sdk/extensions/{Extension,errors,testKit,index}.js`, `tests/unit/sdk.test.js`
  (+13 tests), SDK guide, migration guide, an SDK example, architecture + class diagrams.
- Zero hot-path change; A/B byte-identical; existing raw extensions unaffected.
- Follow-on (behind these ports, deferred): a scaffolding CLI, TypeScript typings, and a
  published package boundary. Durable config sources and a KMS signature root remain platform
  concerns from ADR-017.

## Rollback

Delete `src/sdk/` + `tests/unit/sdk.test.js` + the SDK docs/example. Nothing imports the SDK
at runtime, so removal is inert and the Phase-14.2 platform is unchanged.
