# Enterprise Notification Kernel — Provider Guide (ADR-030 §4)

A Notification provider **delivers only**. It hands a fully-rendered notification to a
transport and reports the outcome. It never routes, selects channels, schedules, retries,
deduplicates, expires, or tracks lifecycle — all of that lives in the engine, so engine
behavior is identical regardless of which provider is active. This is the seam a future
FCM / APNs / Twilio / email / webhook adapter slots behind.

## Contract

Implement every method. `assertProvider` fails fast at `registerChannel` time if any is
missing.

| Method               | Returns                              | Notes                                          |
| -------------------- | ------------------------------------ | ---------------------------------------------- |
| `name`               | `string`                             | Non-empty adapter name.                        |
| `supports(channel)`  | `boolean`                            | Whether this provider delivers on the channel. |
| `deliver(model)`     | `{ ok, providerId?, reason? }` (async)| The sole delivery call. `ok:false` (or throw) → engine retries per policy. |
| `health()`           | `{ ok, ... }`                        | Liveness.                                      |

### Delivered model shape (read-only to the provider)

```jsonc
{
  "notificationId": "ntf_...",
  "namespace": "default",
  "channel": "push",
  "recipient": "user-123",
  "subject": "…", "title": "…", "body": "…",   // already template-resolved
  "priority": "high",
  "correlationId": "req-9", "workflowId": "wf-42",
  "metadata": {},
  "attempts": 1,
  "checksum": "<sha256 hex>",
  // …status/timestamps/retryPolicy also present
}
```

The provider treats the model as read-only: send it, return the outcome. Do not mutate it,
do not persist lifecycle — the engine owns all of that. A returned `providerId` is recorded
on the delivery for tracking.

## Outcome semantics

- `{ ok: true, providerId }` → the engine marks the notification **delivered**.
- `{ ok: false, reason }` → the engine applies the retry policy: reschedule (if attempts
  remain) or mark **failed**.
- A thrown error is treated as `ok:false` **and** increments `provider_failures_total`.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Records every delivery; supports
  all channels by default (or a configured set). Injectable failure for tests:
  `createMemoryProvider({ failTimes: 2 })` fails the first two attempts per notification;
  `createMemoryProvider({ fail: true })` always fails.

## Future extension points (declared, not implemented)

`fcm`, `apns`, `twilio`, `email`, `webhook`, `custom`.

```js
const { futureProvider } = require('../../src/application/notifications-kernel/providerPort');
const p = futureProvider('fcm'); // { planned: true, ... }
p.deliver({}); // throws: "extension point — not implemented in Phase 15.1"
```

## Writing a new provider

1. Implement the contract above; `supports(channel)` should return true only for channels
   this transport handles.
2. In `deliver`, perform the network call and translate the transport's result into
   `{ ok, providerId?, reason? }`. Never throw for an expected delivery rejection — return
   `ok:false` with a reason (reserve throwing for infrastructure faults).
3. Keep it behavior-free — no scheduling/retry/dedup/expiration/tracking. The engine owns
   those.
4. Pull credentials from the Secrets kernel (ADR-028) at composition; do not hard-code
   them or read them from the model.
5. Register it: `notifications.registerChannel({ channel: 'sms', provider: myAdapter })`.
