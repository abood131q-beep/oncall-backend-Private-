# On Call Platform — Engineering Backlog

Maintained by the Principal Engineering Team. Single source of truth for platform-wide work.
Last updated: 2026-07-16. Status baseline: lint PASS, unit 55/55 PASS, MCP build/tools PASS, P6-06 NOT closed.

## Critical

- **C-1 — Financial consistency under concurrent trip completion** (backend)
  Two simultaneous `PUT /taxi/trips/:id/status` completions → HTTP 500 + inconsistent payment state
  (`completeTrip` commits before payment transaction). Root: single shared SQLite connection;
  nested `BEGIN` fails. Proven live (P6-06 §5). RELEASE BLOCKER.
  Affected: database.js `dbTransaction`, TripRepository, payment service, taxi routes.
  Same root causes admin race losers to return 500 instead of 409 (P6-06 §3) — one structural fix covers both.

## High

- **H-1 — BUG-2: legacy driver toggle bypasses approval_status** (backend + admin UI)
  `PUT /admin/drivers/:phone/toggle` sets `is_active=1` but login gates on `approval_status`
  → toggled-active pending driver still cannot log in. DESIGN DECISION NEEDED:
  (a) block toggle for drivers, or (b) sync it with approval_status.
  Affected: src/routes/admin.js, integration test #4, admin_dashboard.dart toggle button, MCP admin tools.

- **H-2 — Flutter app ignores critical socket events** (oncall_app)
  App has no listeners for `force_disconnect` (suspended driver keeps stale UI session),
  `driver:error`, `new:trip:request`. Affected: lib/services/socket_service.dart, driver screens.

- **H-3 — Flutter validation gap** (oncall_app)
  `flutter analyze` / `flutter test` never executed (no SDK in validation environment); no CI
  workflow for the app repo. Mobile side is uncertified.

## Medium

- **M-1 — App never revokes tokens on sign-out** (oncall_app + backend contract)
  App does not call `POST /logout` / `/auth/logout-all`; refresh token stays valid after local sign-out.
- **M-2 — Revoked refresh_tokens rows accumulate** (backend)
  Cleanup job purges expired but not revoked rows. Slow growth, low risk.
- **M-3 — API contract triplication** (all repos)
  Shapes defined 3×: SQLite schema / Dart JSON parsing / MCP zod schemas. Add OpenAPI spec as
  single reference (docs-only task, no code change).
- **M-4 — Race-loser responses: 409 semantics** (backend)
  Covered by C-1 fix; verify separately after.
- **M-5 — Native Prometheus /metrics endpoint in backend** (backend; approval-gated app change)
  P7-04 observes the backend via blackbox `/health` probes + nginx edge metrics + cAdvisor
  only, because `/admin/metrics` is admin-JWT JSON (unscrapeable) and app code changes were
  out of scope. Adding prom-client exposition (internal-network-only) unlocks the business
  panels: requests/sec by route, status codes, active users/drivers/rides/scooters.

## Low

- **L-1 — `_DColors` duplicates `AppTheme`** (oncall_app, admin_dashboard.dart)
- **L-2 — Root-level re-export stubs in lib/** (oncall_app; benign, defer)
- **L-3 — Repo hygiene** (backend: stale `.fuse_hidden*`, empty `database.sqlite`; requires explicit
  deletion approval)

## Rules

Work top-down by priority. One task at a time. Full validation after each task.
Stop and await approval after every completed task. Never commit/push. Never delete data.
