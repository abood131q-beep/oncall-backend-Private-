# Messaging Platform — Provider Guide (ADR-024)

A **provider** is a transport for one messaging technology. It owns the subscriber registry
and target selection; it performs no retry, TTL, DLQ, events, or business logic — those live
in the Messaging service. Business logic never imports a provider; the composition root wires
it behind the port.

## The provider port

`src/application/messaging/providerPort.js`:

```js
{
  name,                                          // string id
  subscribe(topic, handler, { group?, id? }) -> { id, topic, group },
  unsubscribe(id) -> boolean,
  select(topic) -> [{ id, group, handler }],     // ONE member per group (competing consumers);
                                                 // each distinct group represented (pub/sub)
  selectAll(topic) -> [{ id, group, handler }],  // EVERY subscriber (broadcast)
  subscriberCount(topic?) -> number,
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. Group semantics: subscribers
sharing a `group` compete (one gets each message, round-robin); distinct groups each get a copy.
The default group is unique per subscriber, so with no group set you get classic pub/sub.

## Implemented adapter

### Memory — `createMemoryProvider({ name? })`

In-process registry (`topic → subscribers`) with per-(topic,group) round-robin cursors. Single
process — **not a broker**. Ideal for tests and single-node deployments.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `kafka`, `rabbitmq`, `nats`, `redis-streams`, `azure-service-bus`,
`google-pubsub`, `amazon-sqs-sns`. `futureProvider(name)` returns a guard whose operations throw
a clear "extension point — not implemented" error.

## Writing a new provider (e.g. NATS)

A broker adapter maps `group` to the broker's consumer-group concept and implements
`select`/`selectAll` in terms of the broker's routing. For brokers that invoke handlers
themselves (push), the adapter can register the service's dispatch callback on subscribe and
represent `select` as the broker's delivery — the service still owns retry/TTL/DLQ by wrapping
the handler it registers. Then pass it as `createMessagingPlatform({ provider })`.

```js
function createNatsProvider({ nc }) {
  const subs = new Map();
  return {
    name: 'nats',
    subscribe(topic, handler, { group } = {}) {
      const sub = nc.subscribe(topic, { queue: group });
      (async () => { for await (const m of sub) await handler(decode(m)); })();
      const id = String(sub.getID());
      subs.set(id, sub);
      return { id, topic, group: group || `__solo__:${id}` };
    },
    unsubscribe(id) { const s = subs.get(id); if (s) { s.unsubscribe(); subs.delete(id); return true; } return false; },
    select() { /* broker fans out; return [] and publish through nc in a custom route */ },
    selectAll() { /* ... */ },
    subscriberCount() { return subs.size; },
    health: () => ({ ok: true, provider: 'nats' }),
  };
}
```

> Note: durable queues, partition/ordering guarantees, and exactly-once semantics are broker
> capabilities designed into the adapter + service in a later phase; the memory provider is
> single-process and at-least-once (retry may re-deliver).

## Guarantees the service adds on top of any provider

Retry with dead-letter, TTL expiry, request/reply correlation, lifecycle events, metrics, and
the ack/nack abstraction — so providers stay simple and swappable.
