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
Delete the modules + tests; nothing imports them on the hot path, so removal is inert.

---

## Amendment A-001 (2026-07-20) — Advanced backbone closures (review response)

An expert review raised six production-grade points. Status after closure:

1. **Transactional Outbox (#1)** — added `application/shared/outbox.js`: `begin()/stage()/
   persist(txRunner)/relay()` + `relayPending()`. Events are relayed **only after** the
   surrounding transaction commits (a thrown tx never reaches `relay()` ⇒ no phantom
   events); a durable store enables crash-recovery re-publish (at-least-once). In-memory
   store default; durable SQLite/PG adapter is a drop-in behind the store port.
2. **Event Contracts (#2)** — added `domain/shared/eventCatalog.js`: frozen `(type,version)`
   registry (TripRequested v1, TripAccepted v1, TripStarted v1, TripCompleted v1,
   PaymentCompleted v1, ScooterUnlocked v1, …) with `defineEvent` validating producer +
   required payload keys. Meaning is immutable; a change is a new version entry.
3. **Correlation / Causation (#3)** — envelope now carries `correlationId` (self for a root,
   inherited down a chain) and `causationId` (parent id; null at root). `follows(parent,…)`
   propagates the trace automatically.
4. **Event Store (#4)** — added `application/shared/eventStore.js`: append-only store port
   (in-memory default) with replay `readBySubject` / `readByCorrelation`; `withStore(pub,store)`
   records every published event without altering publish semantics.
5. **EventPublisher port (#5)** — added `application/shared/eventPublisher.js`: the named
   swappable contract (`publish`, optional `subscribe`) with `assertPublisher` + a null
   publisher. The in-process bus is one adapter; Kafka/Rabbit/NATS adapters drop in without
   touching Domain/Application.
6. **Idempotency keyed on eventId (#6)** — confirmed by explicit tests: two events with an
   **identical payload but different ids are NOT deduped** (distinct facts); the **same id
   redelivered IS deduped**. Dedupe never keys on payload.

Closure evidence: +13 tests (`tests/unit/eventBackbone.test.js`), full suite 205→**218**,
lint/format clean, all application A/B harnesses still byte-identical (zero hot-path change).
All additions are additive and port-based; rollback remains inert.
