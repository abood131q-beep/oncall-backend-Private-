# ADR-024 — Enterprise Messaging Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.5 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-021 (Storage), ADR-022 (Lock),
ADR-023 (Workflow)

## Context

Platform Services and Extensions need to exchange messages — point-to-point work queues,
publish/subscribe fan-out, broadcasts, and request/reply — without binding to Kafka,
RabbitMQ, NATS, or a queue library. This is the Messaging Kernel: one platform-wide messaging
abstraction, additive, in-process by default, deterministic, provider-based, reachable only
through a Port. **No broker dependency.**

## Decision

Add a self-contained, additive Messaging Platform. Nothing in it is on a hot path, so the
platform runs byte-identically whether or not messaging is instantiated.

**Domain (pure):**

- `message.js` — the Message value object: messageId, correlationId, conversationId, headers,
  payload, metadata, priority, ttl/expiresAt, topic, channel, timestamp, version; `isExpired`,
  `reto` (conversation continuation), `toModel`.
- `errors.js` — `MessagingError`, `MessageValidationError`, `NoSubscriberError`,
  `RequestTimeoutError`.
- `events.js` — the messaging event catalog (MessagePublished/Delivered/Expired/Retried,
  DeadLettered, SubscriberRegistered/Removed); producer `messaging`.

**Application (ports & adapters):**

- `providerPort.js` — the transport contract (`subscribe/unsubscribe/select/selectAll/
  subscriberCount/health`) + declared extension points (Kafka, RabbitMQ, NATS, Redis Streams,
  Azure Service Bus, Google Pub/Sub, Amazon SQS/SNS). The provider owns the subscriber
  registry + group selection; the service invokes handlers and owns policy.
- `providers/memory.js` — the implemented in-process transport (group round-robin +
  pub/sub-across-groups).
- `metrics.js` — published/delivered/failed, retries, dead letters, subscribers, delivery
  latency, queue depth; Prometheus.
- `messagingPort.js` — the abstraction contract (`assertMessaging`).
- `messagingService.js` — the kernel: `publish/subscribe/unsubscribe/request/reply/broadcast/
  health`. Delivery models (point-to-point via consumer group, pub/sub across groups,
  broadcast, request/reply via correlation), retry, TTL expiration, dead-letter, and an
  acknowledgement abstraction (handler resolves = ack, throws = nack → retry/DLQ). Lifecycle
  events through the EventPublisher port only.
- `sdkAdapter.js` — `toMessagingPort(messaging, { owner, canPublish, canSubscribe })`: topic
  namespace isolation + ownership + `messaging:publish`/`messaging:subscribe` capability
  enforcement + correlation validation.
- `index.js` — `createMessagingPlatform(deps)` composition root.

## Kernel integration

Per §5, the Messaging Kernel integrates with the other kernels **only through their existing
ports** — the Event Backbone (EventPublisher port) for lifecycle events, and optionally the
Scheduler/Storage/Configuration ports for delayed redelivery, durable queues, and policy. It
imports no implementation classes from other kernels.

## Alternatives rejected

- **A broker client (Kafka/Rabbit/NATS)** — rejected: couples to one technology; brokers are
  swappable behind the provider port, and the kernel must run without any of them.
- **Provider invoking handlers with policy baked in** — rejected: retry/TTL/DLQ are the
  service's concern; the provider only registers + selects targets.
- **Exposing the provider to extensions** — rejected: breaks isolation. Extensions get only
  the namespace-scoped port.

## Consequences

- New files under `src/domain/messaging/**` and `src/application/messaging/**`, plus
  `tests/unit/messaging.test.js` (+16 tests). Zero hot-path change; A/B byte-identical.
- Durable queues, partitioning/ordering guarantees across processes, and broker-backed
  consumer groups are future work behind the provider port.

## Rollback

Delete `src/domain/messaging/`, `src/application/messaging/`, and
`tests/unit/messaging.test.js`. Nothing imports them at runtime, so removal is inert and every
prior kernel is unchanged.
