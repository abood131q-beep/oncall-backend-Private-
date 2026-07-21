# Phase 17.2 — Compatibility Verification Report

**Question:** does running OnCall as an Enterprise Hosted Service change any externally
observable behavior? **Answer: No.** Behavior is identical by construction, and the checks
runnable in the analysis environment all pass. The live HTTP byte-diff must be executed on a
platform where the `sqlite3` native binding loads (the app's normal OS / CI) — a ready
harness is provided.

---

## 1. Compatibility argument (why identical by construction)

Both modes execute the **same** `createOnCallApplication()` object and the **same**
`start()`/`stop()`. The request-handling code path — Express app, legacy + layered routers,
middleware, Socket.IO handlers, DB helpers, background jobs — is one shared module used
unchanged. Nothing in that module was rewritten; it was relocated verbatim from `server.js`.
Therefore routes, status codes, headers, response bodies, Socket.IO events, JWT behavior, DB
access, background jobs, health endpoints, and `/metrics` cannot differ between modes.

`git status` confirms the blast radius: only `server.js` (reduced to an 88-line launcher) and
`.env.example` (flag docs) changed. `src/routes`, `src/presentation`, `src/services`,
`src/repositories`, `src/middleware`, `src/socket.js`, `src/config`, `database.js`, and
`migrations/` are **untouched**.

## 2. Checks executed in the analysis environment (all PASS)

| Check | Result | Evidence |
|---|---|---|
| Full project lint (CI gate `eslint 'src/**/*.js' server.js database.js --max-warnings 0`) | ✅ exit 0 | run captured |
| New unit tests (adapters + hosted-service) | ✅ 12/12 pass | `node --test` |
| Enterprise-layer regression (host + deployment + new) | ✅ 57/57 pass | `node --test` |
| Full Host lifecycle with injected fake app (bootstrap→host→register→start→health→verify→stop) | ✅ pass | smoke script |
| Hosted-service §2 contract conformance (9 methods) | ✅ `assertServiceContract` ok | test |
| Adapter layer inert (no kernel consumed) | ✅ `consumed() === []`, 12 adapters | test |
| `onCallApplication.js` structurally valid (loads except sqlite native binding) | ✅ only `ERR_DLOPEN_FAILED` | require probe |
| Boot-mode selection strictly by `PLATFORM_ENABLED`+`PLATFORM_HOST` | ✅ all cases | test |

## 3. Checks that must run on the app's normal OS / CI

The analysis sandbox is a different CPU/OS from the app's runtime, so `node_modules/sqlite3`
(a native addon built for the app's machine) fails to `dlopen` here. Any check that boots the
real HTTP server therefore cannot run in the sandbox and was **not** executed here. These are
provided ready-to-run and must be green before sign-off:

| Gate | Command | What it proves |
|---|---|---|
| **Mode-parity A/B** (new) | `node tests/integration/mode-parity-ab.mjs` | Boots BOTH modes on separate ports/DBs and asserts byte-identical status + body + contract headers for `/`, `/test`, `/health`, `/health/live`, `/metrics`, a 404, and a validation path. |
| Existing per-context A/B suite | `npm run test:ab` | Legacy-vs-layered router byte-identity (unchanged by 17.2). |
| Full integration suite | `node integration-test.mjs` (server running) | End-to-end route/socket behavior. |
| Unit suite (DB-backed) | `npm run test:unit` | App-context unit tests that exercise repositories. |

> The mode-parity harness prints `Result: IDENTICAL` on success and is auto-discovered by
> `scripts/run-ab.mjs` (it matches `tests/integration/*-ab.mjs`), so it is wired into
> `npm run test:ab` / `npm run ci`.

## 4. Per-surface compatibility assessment

| Surface | Changed? | Basis |
|---|---|---|
| Routes / mounting order | No | same routers, same `app.use` order, same `*_LEGACY` flags — relocated verbatim |
| HTTP status codes | No | same handlers + same 404 + same 4-arg error handler (413/400/500) |
| Headers | No | same `setupMiddleware` (helmet, compression, request-id, CORS, security headers) |
| Response bodies (incl. Arabic messages) | No | byte-for-byte same handler code |
| Socket.IO events / rooms / rate limits | No | `src/socket.js` untouched; same `io` construction options |
| JWT / auth | No | `src/middleware/auth.js` untouched; same issue/verify/refresh/revocation |
| Database access / schema | No | `src/config/database.js`, `database.js`, `migrations/` untouched |
| Background jobs | No | same `startBackupSchedule`, cache sweep, WAL timer, taxi auto-fix |
| Health endpoints / `/metrics` | No | same observability + health routers |
| Startup timing | Equivalent | same async sequence; Enterprise adds a one-time Platform-ready gate in front |
| Shutdown timing | Equivalent | same Socket.IO→HTTP close + same 10 s force cap + same exit codes |

## 5. Verdict

Within the analysis environment: **all runnable compatibility checks pass and the design
guarantees identity by sharing one application code path.** Remaining gate: run the
DB-backed suites (especially the new `mode-parity-ab.mjs`) on the app's normal OS / CI and
confirm `Result: IDENTICAL`. No code change is expected to be required — the harness is a
regression guard, not a discovery step.
