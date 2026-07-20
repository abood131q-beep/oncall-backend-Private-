# ADR-017 — Enterprise Extension Platform

**Status:** Accepted · **Owner:** Principal Architecture · **Date:** 2026-07-20
**Phase:** 14.2 · **Depends on:** ADR-002, ADR-005, ADR-006, ADR-016 (Event Backbone)

## Context
The platform needs 10-year extensibility without modifying business logic. Extensions must
add pricing/payment/telemetry/AI/etc. capabilities and react to lifecycle events **through
Ports only**, isolated, observable, and hot-pluggable.

## Decision
Add a self-contained, additive Extension Platform. Nothing in it is imported by hot paths,
so the platform runs byte-identically with or without extensions (all A/B harnesses intact).

**Domain (pure):**
- `manifest.js` — strongly validated descriptor (id, name, version, apiVersion, author,
  description, permissions, capabilities, dependencies, minimumPlatformVersion,
  compatibilityRules, lifecycleHooks, configurationSchema, healthChecks). Invalid manifests
  are **rejected with all errors**, never partially loaded.
- `semver.js` — dependency-free semver (parse/compare/`^`,`~`,`>=`,`<`,exact,`*`).
- `capabilities.js` — closed vocabularies for the 10 capability kinds + permissions.
- `hooksCatalog.js` — the 12 lifecycle hook points; Before* = blocking, others observational.
- `integrity.js` — SHA-256 checksum, injectable signature verifier, api/platform compatibility.

**Application (ports & adapters):**
- `dependencyResolver.js` — graph build, semver satisfaction, **cycle detection**, compat
  verification, topological (dependency-first) load order; rejects incompatible sets.
- `sandbox.js` — **deny-all by default**: an extension receives a frozen context exposing
  only ports whose permission is *both* declared in the manifest *and* granted by the host;
  repositories/DB/filesystem/secrets/network are unreachable otherwise.
- `hookBus.js` — **isolation + per-handler timeout + circuit breaker**. A handler that
  throws or times out is fail-open (never crashes the platform, never blocks other
  handlers); only an explicit `{cancel:true}` from a Before* handler vetoes a flow.
- `metrics.js` — per-extension execution count, failure rate, avg latency, load time,
  health; Prometheus exposition.
- `registry.js` — lifecycle orchestrator: install (security-gated) → enable ⇄ disable →
  upgrade/rollback → uninstall; reload/unload; discovery incl. `findByCapability`. All
  in-process → **no server restart**.

## Alternatives rejected
- Dynamic `require()` of arbitrary code with full host access — rejected: violates the
  sandbox/permission principle (§4). Extensions get only granted ports.
- Rerouting existing modules through hooks now — rejected: would change behavior/break A/B.
  Hooks are available for opt-in adoption; the platform emits nothing through them yet.

## Consequences
- +16 tests (`tests/unit/extensions.test.js`), full suite 224→**240**. Zero hot-path change;
  A/B byte-identical; lint/format clean. Durable manifests store, real signature root (KMS),
  and hot-path hook emission are future wiring behind these ports.

## Rollback
Delete `src/{domain,application}/extensions/` + test. Nothing imports them at runtime, so
removal is inert.
