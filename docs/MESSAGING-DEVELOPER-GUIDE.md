# Enterprise Messaging — Developer Guide (ADR-024)

The Messaging Kernel is the platform-wide messaging abstraction. It is **not Kafka/RabbitMQ/
NATS** and **not a queue library**. Every Platform Service and Extension exchanges messages
through this Port; no consumer knows which transport is active. It is **in-process** by default
with no broker dependency.

## 1. Compose

```js
const { createMessagingPlatform, providers } = require('../../src/application/messaging');

const mq = createMessagingPlatform({
  provider: providers.createMemoryProvider(), // default
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  retryPolicy: { maxAttempts: 2, delayMs: 0 }, // default per-delivery retry
});
const M = mq.messaging;
```

## 2. The message

A message carries `payload` plus routing/ordering hints: `topic`, `channel`, `priority`,
`ttlMs`, `correlationId`, `conversationId`, `headers`, `metadata`, a `timestamp`, and a
`version`. `correlationId` defaults to the message's own id (root of a chain).

## 3. Delivery models

```js
// pub/sub — every distinct subscriber (default: each subscriber is its own group)
M.subscribe({ topic: 'trips', handler: (m) => {} });
await M.publish({ topic: 'trips', payload: { id: 1 } });

// point-to-point — subscribers sharing a group compete; each message goes to ONE
M.subscribe({ topic: 'work', group: 'workers', handler: (m) => {} });
M.subscribe({ topic: 'work', group: 'workers', handler: (m) => {} });
await M.publish({ topic: 'work', payload: { n: 1 } }); // round-robin within the group

// broadcast — every subscriber regardless of group
await M.broadcast({ topic: 'sys', payload: {} });

// request/reply — resolves with the reply payload
M.subscribe({ topic: 'rpc', handler: (m) => M.reply(m, { echo: m.payload.v }) });
const reply = await M.request({ topic: 'rpc', payload: { v: 42 }, timeoutMs: 5000 });
```

`subscribe` returns `{ id, topic, group, unsubscribe() }`. Use `M.unsubscribe(id)` too.

## 4. Acknowledgement, retry, dead letter

A handler that **resolves** acks the message; one that **throws** nacks it. On nack the
delivery is retried per the retry policy (`{ maxAttempts, delayMs }`, per-publish override
available); once retries are exhausted the message is **dead-lettered**
(`M.deadLetters()`), and a `DeadLettered` event is published. One failing subscriber never
blocks healthy subscribers.

## 5. TTL

Set `ttlMs` (or an absolute `expiresAt`); a message past its expiry is not delivered — a
`MessageExpired` event is published instead.

## 6. Events (through the port only)

`MessagePublished`, `MessageDelivered`, `MessageExpired`, `MessageRetried`, `DeadLettered`,
`SubscriberRegistered`, `SubscriberRemoved` — all via the Event Backbone, producer
`messaging`. The EventBus is never exposed.

## 7. Observability

```js
mq.metrics.snapshot(); // published/delivered/failed, retries, dead letters, subscribers,
// delivery latency, queue depth
mq.metrics.prometheus();
await M.health();
```

## 8. SDK integration (ADR-018)

```js
const { toMessagingPort } = require('../../src/application/messaging/sdkAdapter');

const portFactories = {
  'messaging:publish': () => toMessagingPort(mq.messaging, { owner: extId, canSubscribe: false }),
  'messaging:subscribe': () => toMessagingPort(mq.messaging, { owner: extId }),
};
// Inside the extension: this.messaging().publish({ topic: 'chan', payload })
```

Topics are namespaced to the extension (`ext.<owner>.`), so an extension can only publish to
and subscribe within its own namespace — it can never address another extension's topics.
Publish/request/broadcast require `messaging:publish`; subscribe/unsubscribe/reply require
`messaging:subscribe`; `reply` is restricted to the owner's namespace.

## Out of scope (future work behind the provider port)

Durable queues, cross-process partitioning/ordering guarantees, and broker-backed consumer
groups (Kafka/Rabbit/NATS/…) are declared extension points, not implemented in this phase.
