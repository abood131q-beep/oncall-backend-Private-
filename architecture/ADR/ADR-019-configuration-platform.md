# ADR-019 — Enterprise Configuration Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.3.2 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK)

## Context

Extensions, platform services, and mobility modules each read configuration ad hoc (env
vars, files, constants). There is no single source of truth, no deterministic precedence,
no validation-before-activation, no live reload, and no redaction of secrets in logs. As a
Kernel Service — not an application feature — configuration must be obtained **exclusively**
through one abstraction so no consumer knows which source is active.

## Decision

Add an additive, dependency-free Configuration Platform. Nothing in it is imported by a hot
path, so the platform runs byte-identically whether or not it is instantiated.

**Domain (pure):**

- `precedence.js` — deterministic layered resolution, highest→lowest:
  `runtime → tenant → organization → environment → provider → file → default`. Same inputs
  ⇒ same output, always.
- `schema.js` — validation engine: required, optional, default, type, enum, min/max, regex
  pattern, custom validators, nested objects, arrays. Returns normalized config or all errors.
- `redaction.js` — detects sensitive keys (passwords, tokens, private keys, credentials, API
  secrets) and redacts values on observability surfaces. It does **not** manage secrets —
  that is the Secret Provider's job (a future phase, deliberately not implemented).
- `events.js` — self-contained config event catalog (`ConfigurationChanged`, `…Reloaded`,
  `…ValidationFailed`, `…Rollback`, `…ProviderChanged`) building canonical DomainEvents
  (producer `config`). The shared platform event catalog is untouched.

**Application (ports & adapters):**

- `providerPort.js` — the `ConfigProvider` contract (`name`, `layer`, `load()`, optional
  `get`/`watch`) plus declared extension points for future providers (Redis, PostgreSQL,
  Consul, etcd, Vault, AWS AppConfig, Azure App Configuration, Google Runtime Config).
- `providers/{env,jsonFile,memory}.js` — the three implemented adapters. File/env I/O is
  injected for testability.
- `cache.js` — version-tracked cache: lazy load, invalidation, freshness check (reload
  optimization), hit/miss stats.
- `metrics.js` — provider latency, reload duration/count, validation failures, cache
  hit/miss ratio, subscriber count, watch notifications; Prometheus exposition.
- `configService.js` — the abstraction: `get/require/exists/list/watch/reload/validate/
  snapshot/version`, precedence resolution, **runtime reload with automatic rollback** on
  validation failure, subscription model (old/new/timestamp/version/origin), and lifecycle
  events through the **EventPublisher port only**.
- `sdkAdapter.js` — bridges ADR-018: turns the service into a `read:config` port or a
  `configProvider` function so `this.config()/reloadConfig()/validateConfig()` work without
  exposing provider internals.
- `index.js` — `createConfigurationPlatform(deps)` composition root.

## Alternatives rejected

- **Direct `process.env` / file reads in consumers** — rejected: no precedence, no
  validation, no redaction, no single source of truth.
- **Extending the shared event catalog for config events** — rejected: keep the platform
  additive and self-contained; config events live in their own domain catalog.
- **Managing secrets here** — explicitly out of scope; secrets belong to the Secret Provider
  (future phase). This platform only redacts.

## Consequences

- New files under `src/domain/config/**` and `src/application/config/**`, plus
  `tests/unit/config.test.js` (+17 tests). Zero hot-path change; A/B byte-identical; no
  existing module modified.
- Reads are synchronous off a cached snapshot; reload is async and rolls back atomically on
  invalid input, so a bad change can never activate.
- Distributed providers and Secret management are future wiring behind the existing ports.

## Rollback

Delete `src/domain/config/`, `src/application/config/`, and `tests/unit/config.test.js`.
Nothing imports them at runtime, so removal is inert and the platform is unchanged.
