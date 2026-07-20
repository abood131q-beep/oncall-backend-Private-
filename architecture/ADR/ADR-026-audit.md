# ADR-026 — Enterprise Audit Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.7 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-023 (Workflow), ADR-024 (Messaging),
ADR-025 (Policy)

## Context

The platform needs a trustworthy record of significant business and platform events — who did
what, to which resource, when, and in what correlation/workflow/message context — for
traceability, compliance, and forensic analysis. This is the Audit Kernel: an **immutable,
append-only** record of facts. It is **not application logging**, **not a logging framework**,
and **not observability**.

## Decision

Add an additive, append-only Audit Platform. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not audit is instantiated.

**Domain (pure):**

- `record.js` — the immutable AuditRecord value object (auditId, timestamp, actor, subject,
  action, resource, category, severity, correlationId, conversationId, workflowId, messageId,
  metadata, sequence, prevChecksum, checksum, version). Frozen on creation; each record's
  `checksum` is a sha256 over its content **plus the previous record's checksum**, forming a
  tamper-evident **hash chain** per namespace. `verifyChecksum` recomputes and compares.
- `query.js` — a deterministic filter (fields + time-range + metadata) / sort / paginate over
  loaded records for timeline reconstruction.
- `errors.js` — `AuditError`, `AuditValidationError`, `AuditIntegrityError`.
- `events.js` — the audit event catalog (AuditRecorded, AuditVerified, AuditIntegrityFailure);
  producer `audit`.

**Application (ports & adapters):**

- `providerPort.js` — an **append-only** record-store contract (`append/scan/get/count/tail/
  health` — no update, no delete) + declared extension points (Storage, PostgreSQL, MongoDB,
  Object Storage). Providers persist records only; the engine owns integrity + query.
- `providers/memory.js` — the implemented in-process append log.
- `metrics.js` — records written, queries executed, verification/checksum/provider failures,
  query latency, uptime; Prometheus.
- `auditPort.js` — the abstraction contract (`assertAudit`).
- `auditService.js` — the kernel: `record/query/get/verify/health`. Appends are serialized per
  namespace so each record's sequence + prevChecksum link correctly. `verify` checks every
  record's checksum, chain linkage, and sequence. Lifecycle events through the EventPublisher
  port only.
- `sdkAdapter.js` — `toAuditPort(audit, { owner, canRead, canWrite })`: namespace isolation +
  `audit:read`/`audit:write` capability enforcement (actor defaults to the owner).
- `index.js` — `createAuditPlatform(deps)` composition root.

## Kernel integration

Per §5, the Audit Kernel integrates with other kernels **only through their existing ports** —
the Event Backbone (EventPublisher) for lifecycle events, and optionally Storage for a durable
append log and the Workflow/Messaging/Policy correlation ids carried on each record. It imports
no implementation classes.

## Alternatives rejected

- **A logging framework / log aggregation** — rejected: logs are mutable, lossy, and not
  tamper-evident; audit records are immutable facts with a verifiable chain.
- **Mutable audit rows** — rejected: append-only + hash chain is what makes the trail
  forensically trustworthy.
- **Provider-side integrity** — rejected: the engine owns checksum + chain verification so the
  guarantee is uniform regardless of provider.

## Consequences

- New files under `src/domain/audit/**` and `src/application/audit/**`, plus
  `tests/unit/audit.test.js` (+12 tests). Zero hot-path change; A/B byte-identical.
- Durable append logs (Storage/Postgres/Mongo/object storage) and cross-shard chains are
  future work behind the provider port.

## Rollback

Delete `src/domain/audit/`, `src/application/audit/`, and `tests/unit/audit.test.js`. Nothing
imports them at runtime, so removal is inert and every prior kernel is unchanged.

## Amendment A-001 — Production hardening (2026-07-20)

A hardening pass added the following **additively** — no public API signature changed, no
module was rewritten, and behavior for existing callers is unchanged:

- **Immutable snapshot** — `snapshot(namespace, auditId)` returns a deep-frozen record copy.
- **Startup verification** — `verifyStartup()` checks provider + clock wiring.
- **Provider / namespace-consistency verification** — `verifyProvider(namespace)` checks
  count == scan length, `tail` == last record, and contiguous sequences.
- **Chain reconciliation** — `reconcile(namespace)` returns the longest intact prefix
  (`lastGoodSequence`, `firstBreak`) without mutating the immutable trail.
- **Recovery after provider failure** — `recover(namespace)` reports the trustworthy boundary
  (`intactThrough`) so consumers can resume from a known-good point; it never rewrites/deletes.
- **Query-determinism verification** — `verifyQuery(spec)` runs a query twice and compares.
- **Lifecycle + query history** — bounded ring buffers via `history()` and `queryHistory()`
  (`historyLimit`, default 500).
- **Structured diagnostics** — `diagnostics(namespace)` (count, chain, startup, metrics).
- **Metrics** — added `audit_integrity_failures_total` (chain/sequence failures, distinct from
  checksum failures).

New optional dep: `historyLimit`. Tests: `tests/unit/audit-hardening.test.js`.
