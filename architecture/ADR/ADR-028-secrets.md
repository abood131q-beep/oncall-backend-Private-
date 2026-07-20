# ADR-028 — Enterprise Secrets Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 14.9 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-025 (Policy), ADR-026 (Audit),
ADR-027 (Identity)

## Context

The platform needs a single, provider-agnostic way to manage sensitive configuration
and credentials: store them, resolve them deterministically, rotate them, and retire
them — with integrity guarantees, secure redaction, and namespace isolation. This is
the Secrets Kernel. It is **not a password manager** and is **not HashiCorp Vault / AWS
Secrets Manager / Azure Key Vault / Google Secret Manager** — those are provider
extension points, not dependencies.

Secret management must never be embedded inside individual services (each rolling its
own env-var parsing or ad-hoc encryption). Instead it is a Kernel Service behind a
narrow port, so every service resolves secrets the same way and secret material is
handled in exactly one place.

To stay strictly additive, the kernel lives under `secrets/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Secrets Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `secret.js` — the Secret value object (secretId, name, namespace, version, `value`
  (protected), `valueChecksum` (integrity fingerprint), metadata, tags, rotationPolicy,
  createdAt, updatedAt, state). The plaintext lives on the model only for the
  authoritative store and `resolve()`; `toPublic()` redacts it. Deterministic
  transitions: `rotate` (version bump), `deprecate`, `markDeleted`, `verifyIntegrity`,
  `isDue`.
- `rotationPolicy.js` — a frozen value object (`enabled`, `intervalMs`, `maxVersions`)
  with a deterministic `isDue(updatedAt, now)`. The engine exposes due-ness; it does not
  self-schedule.
- `redaction.js` — the single place that masks a protected value (`***REDACTED***`,
  constant token — no length or content leak) for any non-authoritative view.
- `errors.js` — `SecretError`, `SecretValidationError`, `SecretNotFoundError`,
  `RotationError`, `IntegrityError`.
- `events.js` — the secrets event catalog (SecretStored, SecretResolved, SecretRotated,
  SecretDeleted); producer `secrets`. Payloads carry only id/name/namespace/version —
  **never a value**.

**Application (ports & adapters):**

- `providerPort.js` — persistence contract (putSecret / getSecret / getSecretVersion /
  listSecrets / listVersions / removeSecret / health) + declared extension points
  (Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager, Custom). Providers
  **store secrets only**; behavior stays in the engine.
- `providers/memoryProvider.js` — the implemented in-process store (current + append-only
  version history per name, per namespace).
- `metrics.js` — stored secrets (gauge), rotations, resolutions, provider failures,
  rotation latency, engine uptime (+ event/integrity failure counters); Prometheus.
- `secretsPort.js` — the abstraction contract (`assertSecrets`): store, resolve, rotate,
  delete, list, health.
- `secretsService.js` — the kernel: versioned secrets, deterministic resolution, rotation
  (with validation), integrity verification, secure redaction, and lifecycle. Values
  never appear in events, the SDK, listings, or diagnostics. Atomic per-secret via a
  serialization mutex. Lifecycle events through the EventPublisher port only.
- `sdkAdapter.js` — `toSecretsPort(secrets, { owner, canRead, canWrite })`: namespace
  isolation + `secrets:read` / `secrets:write` capability enforcement.
- `index.js` — `createSecretsPlatform(deps)` composition root.

## Kernel integration

Per §5, the Secrets Kernel integrates with other kernels **only through their existing
ports** — the Event Backbone (EventPublisher) for lifecycle events; the authorization
context produced by Identity (ADR-027) and evaluated by Policy (ADR-025) governs who may
call `secrets:read`/`secrets:write`; Audit (ADR-026) can record secret events; Storage
(ADR-021) is the model behind future persistence providers; Configuration (ADR-019)
consumes resolved secrets. It imports no implementation classes.

## Alternatives rejected

- **HashiCorp Vault / AWS / Azure / GCP as a dependency** — rejected: couples the platform
  to an external secret product. They remain provider extension points behind the port.
- **Embedding secret handling in each service** — rejected: duplicates sensitive logic and
  defeats uniform redaction/rotation/audit. Secret material is handled in one kernel.
- **Returning plaintext from list/store/events** — rejected: only an explicit `resolve()`
  reveals a value; everything else is redacted.
- **Provider-side rotation/integrity** — rejected: rotation, integrity, and redaction live
  in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/secrets/**` and `src/application/secrets/**`, plus
  `tests/unit/secrets.test.js` (+18 tests). Zero hot-path change; A/B byte-identical.
- Real store integrations (Vault/AWS/Azure/GCP), envelope encryption / KMS-backed
  ciphertext at rest, and automated rotation scheduling are future work behind the
  provider port. The memory provider stores values in-process and is single-process.

## Rollback

Delete `src/domain/secrets/`, `src/application/secrets/`, and
`tests/unit/secrets.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-027) is unchanged. See `docs/SECRETS-ROLLBACK-PLAN.md`
for the full procedure and verification steps.
