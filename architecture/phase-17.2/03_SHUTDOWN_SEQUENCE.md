# Phase 17.2 — Shutdown Sequence

Graceful shutdown order is **preserved exactly**: Socket.IO closes before the HTTP server, a
10-second force-timeout bounds the wait, and process-exit codes match legacy. Both modes use
the same underlying close; only the orchestrator differs.

---

## 1. Application close (shared by both modes)

`createOnCallApplication().stop()` performs the identical close ordering the legacy
`shutdown()` used:

```
clear WAL checkpoint timer
   ↓
io.close()          // stop new Socket.IO upgrades first (L3 fix)
   ↓
server.close()      // drain + close HTTP
   ↓
resolve()           // (never calls process.exit — caller owns exit)
```

## 2. Legacy mode

`server.js` keeps the **verbatim** legacy shutdown handler operating on the application's
`io`/`server`:

```
SIGTERM / SIGINT
  → logger.info('<signal> received — shutting down gracefully')
  → io.close(() => server.close(err =>
        err ? (logger.error + exit 1)
            : (logger.success('Server closed — process exiting') + exit 0)))
  → setTimeout(exit 1, 10_000).unref()   // 'Forced shutdown after 10s timeout'
```

This is the same code as before 17.2, so shutdown behavior and log lines are unchanged.

## 3. Enterprise mode

The Host owns ordering (ADR-044 §5): hosted services stop in reverse dependency order, then
the Runtime shuts down (which delegates platform stop to the Lifecycle kernel, reverse
order). `src/enterprise/index.js` installs the signal handlers:

```
SIGTERM / SIGINT
  → host.stop():
       stopServices(reverse order)   // → OnCallAppService.stop() → application.stop()
                                      //   (io.close → server.close)
       runtime.shutdown()            // → platform reverse-order kernel stop (ADR-040)
  → process.exit(result.ok === false ? 1 : 0)
  → setTimeout(exit 1, 10_000).unref()   // same 10s force cap as legacy
```

Because there is exactly one hosted service, "reverse order" is just: stop OnCall, then stop
the Runtime — i.e. the app closes first (Socket.IO→HTTP), then the (inert, memory-only)
kernels wind down.

## 4. Sequence diagram (Enterprise)

```mermaid
sequenceDiagram
    participant OS as OS signal
    participant E as enterprise signal handler
    participant H as Host
    participant S as OnCallAppService
    participant A as OnCall application
    participant RT as Runtime / Lifecycle

    OS->>E: SIGTERM
    E->>H: host.stop()
    H->>S: stop()  (reverse order; only service)
    S->>A: application.stop()
    A->>A: io.close() → server.close()
    A-->>S: closed
    S-->>H: stopped
    H->>RT: runtime.shutdown()
    RT->>RT: lifecycle reverse-order kernel stop
    RT-->>H: stopped
    H-->>E: { ok }
    E->>OS: process.exit(0)   (or 1 on error / after 10s force)
```

## 5. Parity guarantees
- **Close order identical:** Socket.IO before HTTP in both modes (same `application.stop()`
  in Enterprise; same verbatim handler in Legacy).
- **Force-timeout identical:** 10 s `unref()` timer in both.
- **Exit codes identical:** 0 on clean close, 1 on error/timeout.
- **Verified:** `tests/unit/hosted-service.test.js` asserts `host.stop()` triggers the
  application's `stop` exactly once and returns `{ ok: true }`; the injected-fake smoke test
  confirmed the `start → … → stop` call sequence.
