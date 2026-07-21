# ADR-030 — Enterprise Notification Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.1 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-023 (Workflow), ADR-024 (Messaging),
ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-028 (Secrets)

## Context

The platform needs one deterministic way to orchestrate notifications across every
delivery channel — push, SMS, email, webhooks — with scheduling, retries, deduplication,
expiration, delivery tracking, and an integrity guarantee, independent of any transport.
This is the Notification Kernel. It is **not FCM / APNs / Twilio / SendGrid** — those are
delivery-provider extension points, not dependencies.

Notification logic must never be embedded in individual services (each rolling its own
retry loop and template rendering). Instead it is a Kernel Service behind a narrow port,
so every service sends the same way and the lifecycle is handled in exactly one place.

To stay strictly additive, the kernel lives under `notifications-kernel/`; the
application's existing `notifications` bounded context (`src/domain/notifications`,
`src/application/notifications`) is left completely untouched (its A/B harness stays
byte-identical).

## Decision

Add an additive Notification Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `notification.js` — the Notification value object (notificationId, namespace, channel,
  recipient, template, subject, title, body, priority, status, correlationId, workflowId,
  metadata, scheduledTime, expirationTime, retryPolicy, attempts, deliveries, createdAt,
  updatedAt, version, `checksum`). A canonical content checksum gives integrity; status
  transitions (`markScheduled`/`markSent`/`markDelivered`/`markFailed`/`scheduleRetry`/
  `markCancelled`/`markExpired`) are deterministic.
- `retryPolicy.js` — a frozen value object (maxAttempts, backoffMs, factor, maxBackoffMs)
  with deterministic `shouldRetry` + `nextDelayMs` (exponential, capped).
- `template.js` — deterministic `{{placeholder}}` resolution (unknown → empty, never
  throws) for subject/title/body.
- `errors.js` — `NotificationError`, `NotificationValidationError`,
  `NotificationNotFoundError`, `ChannelError`, `DeliveryError`, `IntegrityError`.
- `events.js` — the notification event catalog (NotificationCreated, NotificationScheduled,
  NotificationSent, NotificationDelivered, NotificationFailed, NotificationCancelled);
  producer `notifications`.

**Application (ports & adapters):**

- `providerPort.js` — the DELIVERY-ONLY contract (name, `supports(channel)`,
  `deliver(model) → { ok, providerId?, reason? }`, health) + declared extension points
  (FCM, APNs, Twilio, email, webhook, custom). Providers deliver; they never route,
  schedule, retry, dedup, expire, or track.
- `providers/memoryProvider.js` — the implemented in-process transport (records
  deliveries; injectable failure for retry/failure tests).
- `store.js` — the engine's in-process repository for notification models (lifecycle
  state). Distinct from the delivery provider; a durable store can implement the same
  interface.
- `metrics.js` — created / sent / deliveries / failures / retries / scheduled (gauge) /
  provider failures / delivery latency / uptime; Prometheus.
- `notificationsPort.js` — the abstraction contract (`assertNotifications`):
  registerChannel, send, schedule, cancel, status, verify, health.
- `notificationsService.js` — the kernel: deterministic routing + channel selection,
  template resolution, tick-driven scheduling (no wall-clock timers), deterministic retry
  backoff, deduplication, expiration, delivery tracking, failure handling, and status
  transitions; mutations are atomic per-notification via a serialization mutex.
- `sdkAdapter.js` — `toNotificationPort(notifications, { owner, canSend, canRead })`:
  namespace isolation + `notification:send` / `notification:read` enforcement (no channel
  registration).
- `index.js` — `createNotificationPlatform(deps)` composition root.

## Kernel integration

Per §5, the Notification Kernel integrates with other kernels **only through their existing
ports** — the Event Backbone (EventPublisher) for lifecycle events; Messaging (ADR-024) can
fan notifications out; Workflow (ADR-023) correlates via `workflowId`; Scheduler (ADR-020)
drives `tick()`; the authorization context from Identity (ADR-027) and Policy (ADR-025)
governs `notification:send`/`notification:read`; Audit (ADR-026) records events;
Configuration (ADR-019) and Secrets (ADR-028) supply channel config + provider credentials.
It imports no implementation classes.

## Alternatives rejected

- **FCM / APNs / Twilio / SendGrid as a dependency** — rejected: couples the platform to an
  external notification product. They remain delivery-provider extension points.
- **Embedding notification logic in each service** — rejected: duplicates retry/template/
  dedup logic and defeats uniform tracking + audit.
- **Wall-clock timers for scheduling/retry** — rejected: the engine is tick-driven with an
  injected clock, so scheduling and backoff are fully deterministic and testable.
- **Provider-side lifecycle** — rejected: routing, scheduling, retry, dedup, expiration,
  and tracking live in the engine so behavior is uniform regardless of transport.

## Consequences

- New files under `src/domain/notifications-kernel/**` and
  `src/application/notifications-kernel/**`, plus `tests/unit/notifications-kernel.test.js`
  (+17 tests). Zero hot-path change; A/B byte-identical (including the app's own
  `notifications-ab`).
- Real transports (FCM/APNs/Twilio/email/webhook), durable persistence, and delivery-
  receipt callbacks are future work behind the provider port. The memory provider + store
  are single-process.

## Rollback

Delete `src/domain/notifications-kernel/`, `src/application/notifications-kernel/`, and
`tests/unit/notifications-kernel.test.js`. Nothing imports them at runtime, so removal is
inert and every prior kernel (ADR-016 … ADR-029) and the app's notifications context are
unchanged. See `docs/NOTIFICATIONS-KERNEL-ROLLBACK-PLAN.md` for the full procedure.
