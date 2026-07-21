# Phase 17.2 — Hosted Service Design

**Status:** Implemented. **Scope:** establish the OnCall backend as a single Enterprise
Hosted Service + the Platform Adapter Layer. **No kernel is consumed yet** (that is a later
phase). Application behavior is unchanged and byte-identical between modes.

---

## 1. Goal

Run the complete, unmodified OnCall backend as ONE Hosted Service managed by the Enterprise
Runtime (ADR-043) and Host (ADR-044), while keeping a fully working legacy boot. Switching is
controlled only by `PLATFORM_ENABLED` and `PLATFORM_HOST`.

## 2. Components introduced (all additive)

| File | Role |
|---|---|
| `src/app/onCallApplication.js` | **Behavior-identical** extraction of the app wiring + startup + shutdown that previously lived inline in `server.js`. Exposes `createOnCallApplication()` → `{ app, server, io, services, start(), stop(), listening(), port }`. Imports NO Enterprise code. |
| `src/hosted-service/onCallAppService.js` | `createOnCallAppService()` — the ADR-044 §2 hosted-service wrapping the application. |
| `src/platform-adapters/**` | The Enterprise Adapter Layer (12 translators + `index.js`). Inert in 17.2. |
| `src/enterprise/index.js` | `bootEnterprise()` — `bootstrap()` → `createHost()` → `register()` → `host.start()` + signal handling. |
| `src/enterprise/mode.js` | `selectBootMode(env)` — pure flag→mode function shared by `server.js` and tests. |
| `server.js` | Reduced to an 88-line **launcher** that branches on the mode flags. |

## 3. The hosted-service contract

The Host requires nine methods (`src/host/hostRegistry.js` → `CONTRACT_METHODS`).
`OnCallAppService` implements all nine, plus `ready()` for OnCall's own semantics:

| Method | Returns | Behavior |
|---|---|---|
| `id()` | `'oncall-backend'` | stable service id |
| `name()` | `'OnCall Backend'` | display name |
| `version()` | package version (`1.0.0`) | injected |
| `dependencies()` | `[]` | the only hosted service; no siblings |
| `start(ctxSlice?)` | `{ started, port }` | builds the application (once) and runs the **exact** existing startup sequence; resolves once listening. Ignores the context slice (OnCall builds its own config from env, unchanged). |
| `stop()` | `{ stopped }` | delegates to the application's identical Socket.IO→HTTP graceful close. Never calls `process.exit` — the Host/launcher owns exit. |
| `health()` | `{ ok, state, checks, uptimeMs }` | lightweight; does **not** touch the DB. Shaped via the (pure) health adapter. |
| `verify()` | `{ ok, checks }` | structural: contract present + adapters inert. |
| `metadata()` | `{ needs:[], adr, phase, kernelsConsumed:[], adapters:[…] }` | reports the inert-adapter posture. |
| `ready()` *(extra)* | `{ ready }` | true once the HTTP server is listening. |

### Design properties
- **Lifecycle delegation only.** The service holds no business logic; it forwards `start`/
  `stop` to the application and reports status. This keeps the wrapper trivial and the app
  the single source of truth.
- **Injectable application factory.** `deps.createApplication` defaults to the real
  DB-backed factory but can be replaced with a fake, so the whole Host lifecycle is testable
  without sqlite/HTTP (see `tests/unit/hosted-service.test.js`).
- **Idempotent** `start()`/`stop()` — repeated calls are no-ops, preventing double-listen or
  double-close under supervisor retries.
- **No kernel consumption.** The adapter layer is injected but every adapter is inert; the
  service reports `kernelsConsumed: []`.

## 4. Why behavior is identical between modes

Both modes construct the **same** `createOnCallApplication()` object and call the **same**
`start()`/`stop()`. The only difference is the caller:

```
LEGACY:      server.js  ──▶ createOnCallApplication().start()
ENTERPRISE:  host.start() ──▶ OnCallAppService.start() ──▶ createOnCallApplication().start()
```

Because the request-handling code path (Express app, routers, middleware, Socket.IO, DB
helpers, background jobs) is a single shared module used unchanged by both callers, API
responses, headers, JWT behavior, Socket.IO events, DB access, jobs, health, and metrics are
identical by construction — not by parallel re-implementation.

## 5. Boundaries honored (ABSOLUTE RULES)

Architecture not redesigned; Express/Socket.IO/middleware/repositories/services **not**
rewritten (relocated verbatim); no API response, auth, DB schema, or Flutter contract
changed; no new kernel or runtime layer created; nothing consumes a kernel. Git confirms
only `server.js` and `.env.example` were modified; `src/routes`, `src/presentation`,
`src/services`, `src/repositories`, `src/middleware`, `src/socket.js`, `src/config`,
`database.js`, and `migrations/` are untouched.
