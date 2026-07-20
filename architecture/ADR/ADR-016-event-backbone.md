# ADR-016 — Event Backbone (In-Process Domain Event Dispatcher)

**Status:** Accepted · **Owner:** Principal Architecture · **Date:** 2026-07-20
**Phase:** 14.1 · **Depends on:** ADR-002 (§8 events), ADR-005 (§12), ADR-006 (§6)

## Context
The gap analysis (2026-07-20) found no domain-event dispatcher: contexts integrated via
Socket.IO emits and direct calls. ADR-006 §6 mandates events as the cross-context backbone.

## Decision
Add an **in-process event bus** as a purely additive Application-layer capability, plus a
pure **DomainEvent** envelope in the Domain shared kernel. Existing synchronous flows are
**not rerouted** — contexts opt in by publishing (after commit) and/or subscribing.

- **DomainEvent** (`src/domain/shared/DomainEvent.js`): frozen envelope
  `{id,type,version,occurredAt,producer,subject,payload}`; injectable clock/id for
  determinism; meaning fixed by `(type,version)`.
- **Event bus** (`src/application/shared/eventBus.js`): `subscribe/publish/drain/stats`;
  handler **isolation** (a throwing handler never blocks others or the publisher),
  bounded **retry** with linear backoff, **dead-letter queue** via an injectable port
  (in-memory default, durable adapter later), **version-pinned** subscriptions,
  **idempotency** aid (event id), and **fire-and-forget** publish (never blocks a request).

## Alternatives rejected
- External broker now (Kafka/Rabbit) — premature; no multi-process need yet (single Node
  process, ADR-001 §A). The port design keeps a broker adapter open for later.
- Rerouting settlement/notifications through async events now — would change behavior and
  break A/B byte-identity. Deferred; the backbone is available for gradual adoption.

## Consequences
- Coverage +11 tests (194→205). Zero hot-path change ⇒ all 10 application A/B harnesses
  remain byte-identical. No new runtime dependency. DLQ/broker are future adapters behind
  the existing port.

## Rollback
Delete the two modules + test; nothing imports them on the hot path, so removal is inert.
