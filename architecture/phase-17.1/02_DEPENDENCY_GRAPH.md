# Phase 17.1 — Dependency Graph (STEP 3)

Shows the required layering:
**Current backend → Enterprise Runtime → Enterprise Platform → Enterprise Kernels.**
Diagrams are Mermaid (renders in the repo's Markdown viewer, consistent with `docs/diagrams`).

---

## 1. Target Layering (the four mandated tiers)

```mermaid
flowchart TD
    subgraph APP["① CURRENT BACKEND (unchanged, hosted service)"]
        A1["server.js bootstrap → OnCallAppService"]
        A2["Express app + routers<br/>src/routes/* + src/presentation/api/*"]
        A3["Socket.IO — src/socket.js"]
        A4["Middleware — auth, rateLimiter, metrics, setup"]
        A5["Services — backup, cache, notif, otp, sms, fare, matcher"]
        A6["Repositories — legacy 7 + infra adapters 15"]
        A7["DB helpers — src/config/database.js (SQLite WAL / PG)"]
    end

    subgraph DEP["Enterprise Deployment (ADR-045) — optional in 17.1"]
        D1["createDeployment({host}) — rollout / rollback / release strategy"]
    end

    subgraph HOST["② ENTERPRISE HOST RUNTIME (ADR-044)"]
        H1["createHost({runtime})"]
        H2["hosted-service registry + isolation"]
        H3["host lifecycle (service start/stop ordering)"]
    end

    subgraph RT["② ENTERPRISE RUNTIME (ADR-043)"]
        R1["bootstrap(options)"]
        R2["assemble: create → verify → start → ready"]
        R3["supervisor / shutdownManager / startupVerifier"]
    end

    subgraph PLAT["③ ENTERPRISE PLATFORM (ADR-042)"]
        P1["createPlatform() composition root"]
        P2["kernelRegistry + dependencyGraph"]
        P3["7-method API: start/shutdown/health/verify/getKernel/listKernels/version"]
    end

    subgraph KERN["④ ENTERPRISE KERNELS (ADR-016 … ADR-041)"]
        K1["config · storage · lock · identity · policy"]
        K2["features · messaging · workflow · audit · scheduler"]
        K3["secrets · notifications · ratelimit · jobs · observability"]
        K4["discovery · gateway · resilience · mesh · tenancy"]
        K5["resources · lifecycle · compatibility · extensions"]
    end

    APP -->|"registered as hosted service via host.register()"| HOST
    D1 -.->|deploys / rolls back| HOST
    HOST --> RT
    RT --> PLAT
    PLAT --> KERN

    APP -.->|"consumes kernel services via Context Adapters (ports only)"| KERN
```

**Reading the graph:** the app plugs in **once**, at the Host, as a hosted service. Control
flows down (Deployment → Host → Runtime → Platform → Kernels); the app additionally reaches
kernels **only through adapters that call public kernel ports** (dashed line) — never by
importing kernel internals, mirroring the Platform's own no-cross-import rule.

---

## 2. Kernel Composition Order (as the Platform builds it)

Derived from `src/platform/platformBuilder.js` `KERNELS` catalog and its topological sort.
Arrows mean "must be composed/started before."

```mermaid
flowchart LR
    EB["event-backbone (016)"] --> CFG["config (019)"]
    CFG --> STO["storage (021)"]
    CFG --> LCK["lock (022)"]
    CFG --> MSG["messaging (024)"]
    CFG --> OBS["observability (033)"]
    CFG --> DSC["discovery (034)"]
    CFG --> RL["ratelimit (031)"]
    CFG --> RES["resilience (036)"]
    CFG --> RSC["resources (039)"]
    CFG --> LFC["lifecycle (040)"]
    CFG --> CMP["compatibility (041)"]

    STO --> IDN["identity (027)"]
    CFG --> IDN
    IDN --> POL["policy (025)"]
    CFG --> POL
    STO --> FEA["features (029)"]
    STO --> AUD["audit (026)"]
    STO --> SEC["secrets (028)"]
    LCK --> SCH["scheduler (020)"]
    SCH --> JOB["jobs (032)"]
    MSG --> NOT["notifications (030)"]
    MSG --> WKF["workflow (023)"]
    LCK --> WKF
    STO --> WKF
    IDN --> TEN["tenancy (038)"]
    POL --> EXT["extensions (017)"]

    IDN --> GW["gateway (035)"]
    POL --> GW
    RL --> GW
    FEA --> GW
    DSC --> GW

    IDN --> MSH["mesh (037)"]
    POL --> MSH
    RES --> MSH
    RL --> MSH
    DSC --> MSH
```

`event-backbone` and `config` are the roots; **`config` is the universal dependency**, which
is why Config is the safest first kernel the app consumes. `lifecycle` orchestrates
start/stop of all the others; `gateway` and `mesh` are the deepest composites (they take
other kernels as injected `ports`).

---

## 3. App-Component → Kernel Consumption Edges (Phase 17.1 target)

Only the edges that Phase 17.1 introduces (wrap + observe). Solid = wrap-now; dashed =
observe-only (no request-path change); dotted = blocked/deferred.

```mermaid
flowchart TD
    ENV["config/env.js"] ==>|mirror| CFGK["Config kernel"]
    HEALTH["observability route + metrics mw"] ==>|feed| OBSK["Observability kernel"]
    BOOT["server.js lifecycle"] ==>|wrap| LFCK["Lifecycle + Host + Runtime"]
    BKP["backup / cache timers"] ==>|register| JOBK["Jobs / Scheduler kernels"]

    AUTH["middleware/auth.js"] -.->|observe| IDNK["Identity kernel"]
    GUARDS["authenticate* / ADMIN_PHONES"] -.->|observe| POLK["Policy kernel"]
    RLMW["middleware/rateLimiter.js"] -.->|observe| RLK["Ratelimit kernel"]
    NOTI["notificationService / sms / otp"] -.->|observe| NOTK["Notifications kernel"]
    LOGS["login_logs / approval_logs"] -.->|observe| AUDK["Audit kernel"]

    DBH["config/database.js"] ...->|blocked B1| STOK["Storage kernel (needs DB provider)"]
    REFRESH["refresh/revoked tokens"] ...->|blocked B2| IDNK
    EXPRESS["Express routing"] ...->|deferred, out of path| GWK["Gateway kernel"]
```

The two dotted "blocked" edges (Storage-owns-DB, Identity-owns-tokens) are the gates in the
Readiness Report; the deferred Gateway edge is intentionally kept out of the request path in
17.1.

---

## 4. Runtime Call/Control Sequence (target boot)

```mermaid
sequenceDiagram
    participant Main as index/boot entry
    participant RT as Runtime (bootstrap)
    participant PL as Platform (createPlatform)
    participant LC as Lifecycle kernel
    participant HS as Host
    participant APP as OnCallAppService (wrapped server.js)

    Main->>RT: bootstrap(options)
    RT->>PL: createPlatform()  %% compose 25 kernels in dep order
    RT->>PL: verifyStartup()   %% abort on failure
    RT->>PL: start()
    PL->>LC: lifecycle.start()  %% dependency-ordered kernel start
    RT-->>Main: Runtime (READY)
    Main->>HS: createHost({runtime})
    Main->>HS: host.register(OnCallAppService)
    HS->>APP: start()  %% migrations → stores → listen → sockets → timers
    APP-->>HS: STARTED
    Note over Main,APP: SIGTERM → host.stop() → APP.stop() (io.close→server.close) → lifecycle reverse stop
```

This sequence preserves the app's current ordering constraint — **migrations complete before
`server.listen`** — by making it the hosted service's `start()` contract, now enforced by the
Host/Lifecycle rather than by statement order in `server.js`.
