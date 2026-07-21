# Enterprise Notification Kernel — Developer Guide (ADR-030)

The Notification Kernel is the platform's unified abstraction for deterministic
notification orchestration across delivery channels. It is **not FCM/APNs/Twilio/SendGrid**
— those are delivery-provider extension points. It lives under `notifications-kernel/`,
separate from the app's `notifications` bounded context, and is additive to every existing
kernel.

## 1. Compose

```js
const { createNotificationPlatform, providers } = require('../../src/application/notifications-kernel');
const nk = createNotificationPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const N = nk.notifications;
```

## 2. Register a channel (bind a transport)

```js
N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
N.registerChannel({ channel: 'sms', provider: myTwilioAdapter }); // future provider
// → { channel, provider }
```

A provider must implement `supports(channel)`, `deliver(model)`, and `health()`. Channel
registration is administrative — it is **not** exposed to extensions.

## 3. Send immediately

```js
const model = await N.send({
  channel: 'push',
  recipient: 'user-123',
  title: 'Ride arriving',
  body: 'Your driver is {{eta}} minutes away', // {{placeholders}} resolved from `data`
  data: { eta: 5 },
  priority: 'high',
  correlationId: 'req-9', // ties into Workflow/Messaging correlation
  workflowId: 'wf-42',
  dedupKey: 'ride-9-arriving', // optional; defaults to a content checksum
  retryPolicy: { maxAttempts: 3, backoffMs: 200, factor: 2 },
  expirationTime: Date.now() + 60000, // optional
});
// → notification model (status: delivered | sent | scheduled(for retry) | failed | expired)
```

## 4. Schedule + tick

```js
const s = await N.schedule({ channel: 'push', recipient: 'u1', body: 'later', delayMs: 60000 });
// or: scheduledTime: <epoch ms>
await N.tick(now); // deliver everything due at `now` (scheduled + retrying); returns a summary
```

The engine is **tick-driven** — it never sets wall-clock timers, so scheduling and retry
backoff are deterministic. Drive `tick()` from the Scheduler kernel (ADR-020) or your own
loop.

## 5. Cancel + status

```js
await N.cancel({ notificationId }); // → true (false if unknown / already terminal)
await N.status({ notificationId }); // → notification model | null
```

## 6. Events (through the port only)

`NotificationCreated`, `NotificationScheduled`, `NotificationSent`, `NotificationDelivered`,
`NotificationFailed`, `NotificationCancelled` — all via the Event Backbone, producer
`notifications`. `NotificationFailed` carries a `reason` and `willRetry`.

## 7. Observability

```js
nk.metrics.snapshot(); // created, sent, deliveries, failures, retries, scheduled (gauge),
// providerFailures, delivery latency, uptime
nk.metrics.prometheus();
await N.health(); // per-channel provider health + counts
```

## 8. SDK integration (ADR-018)

```js
const { toNotificationPort } = require('../../src/application/notifications-kernel/sdkAdapter');
const portFactories = {
  'notification:read': () => toNotificationPort(nk.notifications, { owner: extId, canSend: false }),
  'notification:send': () => toNotificationPort(nk.notifications, { owner: extId }),
};
// Inside the extension: this.notifications().send({ channel, recipient, body })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `send`/`schedule`/
`cancel` require `notification:send`; `status`/`verify` require `notification:read`.
Channel registration is not exposed to extensions.

## 9. Determinism, retry, dedup & integrity

- **Deterministic routing** — the channel is selected by name from the registered
  channels; an unknown channel fails the notification with a `ChannelError` reason.
- **Retry** — a failed attempt reschedules with exponential backoff (`retryPolicy`) until
  `maxAttempts`; `tick()` retries when due. Exhausted retries end in `failed`.
- **Deduplication** — a `dedupKey` (or the content checksum) collapses repeat sends while a
  prior notification is still non-terminal; the existing record is returned.
- **Expiration** — a notification past `expirationTime` is marked `expired` and never
  delivered.
- **Integrity** — every stored notification carries a checksum; `verify()` recomputes it
  across a namespace to detect tampering/corruption.

## Out of scope (future work behind the provider port)

Real transports (FCM/APNs/Twilio/email/webhook), durable persistence, and delivery-receipt
callbacks are declared extension points, not implemented in this phase. The memory provider
and store are single-process.
