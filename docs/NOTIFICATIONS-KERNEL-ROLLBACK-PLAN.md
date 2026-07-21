# Enterprise Notification Kernel — Rollback Plan (ADR-030)

The Notification Kernel is strictly additive. Nothing in the platform imports it at
runtime, so it can be removed with zero effect on any prior kernel (ADR-016 … ADR-029) or
the application (including the app's own `notifications` bounded context). This document is
the procedure to remove it and verify the removal is inert.

## Why rollback is safe

- **No hot-path wiring.** No existing module `require`s `src/application/notifications-kernel`
  or `src/domain/notifications-kernel`. The kernel is only instantiated by an explicit
  `createNotificationPlatform(...)` call, which the base platform does not make.
- **A/B byte-identical.** All ten application A/B compatibility harnesses are byte-identical
  with the kernel present — including `notifications-ab`, which proves the app's existing
  notifications context is untouched.
- **Self-contained + namespaced.** The kernel lives under `notifications-kernel/` (distinct
  directories from the app's `notifications`), and its domain event catalog is local
  (`src/domain/notifications-kernel/events.js`); the shared platform event catalog is
  untouched.

## Procedure

1. Delete the source directories:
   - `src/domain/notifications-kernel/`
   - `src/application/notifications-kernel/`
2. Delete the tests:
   - `tests/unit/notifications-kernel.test.js`
3. (Optional) Delete the docs + diagrams + this ADR if a clean history is desired:
   - `architecture/ADR/ADR-030-notifications.md`
   - `docs/NOTIFICATIONS-KERNEL-DEVELOPER-GUIDE.md`,
     `docs/NOTIFICATIONS-KERNEL-PROVIDER-GUIDE.md`,
     `docs/NOTIFICATIONS-KERNEL-ROLLBACK-PLAN.md`
   - `docs/diagrams/notifications-kernel-architecture.mermaid`,
     `docs/diagrams/notifications-kernel-delivery-flow.mermaid`
4. Remove any composition-root call you added that wires `createNotificationPlatform(...)`
   (the base platform has none).

```bash
rm -rf src/domain/notifications-kernel src/application/notifications-kernel \
       tests/unit/notifications-kernel.test.js
```

## Verification after rollback

Run the standard gate and confirm it is green exactly as before:

```bash
node --test tests/unit/*.test.js         # suite passes (minus the 17 notification-kernel tests)
node scripts/run-ab.mjs                  # 10 app A/B harnesses byte-identical (incl. notifications-ab)
node ./node_modules/prettier/bin/prettier.cjs --check "src/**/*.js" "tests/**/*.js"
npx --no-install eslint src tests
```

`engine-ab.mjs` remains the expected Postgres live-staging gate (infrastructure, not a code
defect) and is unaffected by this rollback.

## Partial rollback (keep the code, disable the feature)

Because the kernel is only active when `createNotificationPlatform(...)` is called, a
feature flag at the composition root is sufficient to disable it without deleting code:
simply do not call the factory. No notification data persists anywhere in the base
platform, since the default store + provider are in-process and live only for the lifetime
of an instantiated kernel.

## Data considerations

The default memory store + provider hold notifications and deliveries in-process only;
removing the kernel discards that in-memory state. If a real transport (FCM/APNs/Twilio/
email/webhook) or durable store had been wired, that data lives in the external system and
is unaffected by removing the kernel code — decommission it separately per its own runbook.
