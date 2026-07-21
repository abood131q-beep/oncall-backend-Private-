'use strict';

/**
 * onCallAppService.js — Phase 17.2
 *
 * The OnCall backend as a single Enterprise Hosted Service (ADR-044 §2 contract). It wraps
 * the UNCHANGED application (src/app/onCallApplication.js) and exposes the nine methods the
 * Host requires — plus ready() for OnCall's own semantics:
 *
 *   id() name() version() dependencies() start() stop() health() verify() metadata()  [+ ready()]
 *
 * Responsibilities are limited to LIFECYCLE DELEGATION:
 *   • start() runs the exact existing startup sequence (Environment → Database → Migrations
 *     → Revocation Store → Rate Limit Store → Redis → Socket.IO → Routes → HTTP Listen →
 *     Background Jobs) by delegating to the application's start().
 *   • stop() runs the exact existing graceful close (Socket.IO → HTTP) by delegating to the
 *     application's stop(). The Host owns process-exit ordering.
 *
 * It contains NO business logic and does NOT consume any Enterprise kernel: the injected
 * adapter layer is INERT in Phase 17.2 (used only to report status in metadata()/health()).
 *
 * The application factory is injectable (deps.createApplication) so the service and the Host
 * lifecycle can be tested without the real DB-backed application.
 */

const SERVICE_ID = 'oncall-backend';
const SERVICE_NAME = 'OnCall Backend';

// Adapters permitted to be "consumed" while remaining NON-authoritative (shadow only).
// 17.3 configuration · 17.4 observability · 17.5 jobs · 17.6 scheduler. Legacy authoritative.
const SHADOW_ONLY_ADAPTERS = new Set(['configuration', 'observability', 'jobs', 'scheduler']);

function createOnCallAppService(deps = {}) {
  const logger = deps.logger || { info() {}, warn() {}, error() {}, success() {} };
  const version = deps.version || '1.0.0';
  const phase = deps.phase || '17.2';
  const adapters = deps.adapters || null;
  // Lazily require the real application only when actually starting, so importing this
  // module (e.g. in tests that inject a fake) never loads the DB-backed application.
  const createApplication =
    deps.createApplication || (() => require('../app/onCallApplication').createOnCallApplication());

  let application = null;
  let startedAt = null;

  // ── §2 contract ────────────────────────────────────────────────────────────────
  function id() {
    return SERVICE_ID;
  }
  function name() {
    return SERVICE_NAME;
  }
  function serviceVersion() {
    return version;
  }
  function dependencies() {
    return []; // the OnCall backend is the only hosted service; it depends on no sibling
  }

  /**
   * Start the OnCall backend. The Host passes the declared context slice; OnCall declares no
   * needs and builds its own configuration from env (unchanged), so the argument is ignored.
   */
  async function start() {
    if (application) return { alreadyStarted: true };
    application = createApplication();
    await application.start(); // identical existing startup sequence; resolves once listening
    startedAt = Date.now();
    logger.success(`Hosted service "${SERVICE_ID}" started on port ${application.port}`);
    return { started: true, port: application.port };
  }

  /** Graceful stop — delegates to the application's identical Socket.IO → HTTP close. */
  async function stop() {
    if (!application) return { alreadyStopped: true };
    const app = application;
    application = null;
    startedAt = null;
    await app.stop();
    logger.info(`Hosted service "${SERVICE_ID}" stopped`);
    return { stopped: true };
  }

  /** Host health contract: { ok, ... }. Lightweight — does not touch the database. */
  async function health() {
    const listening = Boolean(application && application.listening());
    const snapshot = { service: listening ? 'ok' : 'down' };
    const shaped = adapters
      ? adapters.health.toHostHealth(snapshot)
      : { ok: listening, checks: snapshot };
    return {
      ok: shaped.ok,
      state: listening ? 'started' : application ? 'starting' : 'stopped',
      checks: shaped.checks,
      uptimeMs: startedAt ? Date.now() - startedAt : 0,
    };
  }

  /** OnCall-specific readiness (accepting traffic). */
  async function ready() {
    const listening = Boolean(application && application.listening());
    return { ready: listening };
  }

  /** Structural verification (contract-level; no side effects). */
  async function verify() {
    // Any consumed adapter must be shadow-only (non-authoritative); Phase 17.3 permits the
    // configuration adapter in shadow mode. Legacy remains the source of truth regardless.
    const consumed = adapters ? adapters.consumed() : [];
    const shadowOnly = consumed.every((n) => SHADOW_ONLY_ADAPTERS.has(n));
    return {
      ok: true,
      checks: {
        contract: { ok: true },
        adaptersShadowOnly: { ok: shadowOnly, consumed },
      },
    };
  }

  function metadata() {
    return {
      needs: [], // no host context slices required
      adr: 'ADR-044',
      phase,
      kernelsConsumed: adapters ? adapters.consumed() : [],
      adapters: adapters ? adapters.describe() : [],
      description:
        'OnCall backend (Express + Socket.IO + SQLite/PG) running unchanged as a single ' +
        'Enterprise Hosted Service. Any consumed kernel is SHADOW-ONLY (legacy authoritative).',
    };
  }

  return Object.freeze({
    id,
    name,
    version: serviceVersion,
    dependencies,
    start,
    stop,
    health,
    ready,
    verify,
    metadata,
    // test/introspection aid (non-contract): expose the live application when started
    _application: () => application,
  });
}

module.exports = { createOnCallAppService, SERVICE_ID, SERVICE_NAME };
