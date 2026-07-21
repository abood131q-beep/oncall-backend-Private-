# Phase 17.1 — Target Architecture Diagram

The end-state of Phase 17.1: the **unchanged** OnCall backend running as a single isolated
hosted service on top of the Enterprise Platform, consuming kernels only through adapters that
call public ports. Flutter clients, routes, responses, schema, auth, and Socket.IO are
untouched.

---

## 1. Layered Target Architecture

```mermaid
flowchart TB
    subgraph CLIENTS["Clients (UNCHANGED)"]
        FL["Flutter apps<br/>passenger · driver · admin"]
    end

    subgraph EDGE["Process edge (UNCHANGED contract)"]
        HTTP["HTTP :PORT — Express 5 routes"]
        WS["Socket.IO :PORT — JWT handshake, rooms, events"]
    end

    subgraph DEPLOY["Enterprise Deployment (ADR-045) — optional/ops"]
        DP["createDeployment({host}) · rollout · rollback · strategy"]
    end

    subgraph HOST["Enterprise Host (ADR-044)"]
        HREG["hosted-service registry + isolation"]
        subgraph SVC["OnCallAppService (the whole current backend, wrapped)"]
            direction TB
            MW["Middleware: setup · auth · rateLimiter · metrics"]
            RT_L["Routers: legacy src/routes/* + layered src/presentation/api/*"]
            SOCK["src/socket.js handlers + hourly taxi auto-fix"]
            SVCS["Services: backup · cache · notif · otp · sms · fare · matcher"]
            REPO["Repositories: legacy 7 + infra adapters 15"]
            DBH["DB helpers: src/config/database.js (SQLite WAL / PG)"]
        end
    end

    subgraph RUNTIME["Enterprise Runtime (ADR-043)"]
        BOOT["bootstrap() · supervisor · shutdownManager · startupVerifier"]
    end

    subgraph PLATFORM["Enterprise Platform (ADR-042)"]
        CR["createPlatform() · kernelRegistry · dependencyGraph · 7-method API"]
    end

    subgraph KERNELS["Enterprise Kernels (ADR-016…041)"]
        direction LR
        KC["config (019)"]
        KO["observability (033)"]
        KJ["jobs (032) / scheduler (020)"]
        KL["lifecycle (040)"]
        KI["identity (027) — shadow"]
        KP["policy (025) — shadow"]
        KR["ratelimit (031) — shadow"]
        KN["notifications (030) — shadow"]
        KA["audit (026) — shadow"]
        KX["storage/lock/secrets/features/... — composed"]
    end

    subgraph ADAPT["Context Adapters (ports-only bridge)"]
        AD["config-mirror · health-feed · job-register · shadow-compare"]
    end

    FL --> HTTP
    FL --> WS
    HTTP --> MW --> RT_L
    WS --> SOCK
    RT_L --> SVCS --> REPO --> DBH

    DP -.-> HREG
    HREG --> SVC
    HOST --> RUNTIME --> PLATFORM --> KERNELS
    KL -. "orders start/stop of" .- SVC

    SVC <-->|"via adapters, public ports only"| ADAPT
    ADAPT <--> KC
    ADAPT <--> KO
    ADAPT <--> KJ
    ADAPT -. shadow .- KI
    ADAPT -. shadow .- KP
    ADAPT -. shadow .- KR
    ADAPT -. shadow .- KN
    ADAPT -. shadow .- KA
```

**Solid** kernel links (config, observability, jobs, lifecycle) = active wrap-now consumers.
**Dashed** links (identity, policy, ratelimit, notifications, audit) = observe-only shadows —
present, computing, compared, but never in the served path. Storage/lock/secrets/etc. are
composed for a healthy Platform but have no app adapter in 17.1.

---

## 2. Request Path (proves external behavior is unchanged)

```mermaid
sequenceDiagram
    participant FL as Flutter
    participant EX as Express (src/routes / presentation)
    participant MW as auth + rateLimiter (unchanged)
    participant DB as db helpers (SQLite/PG)
    participant SH as Kernel shadows (async, off-path)

    FL->>EX: HTTP request (same route)
    EX->>MW: authenticate + rate limit (verifyJWT, legacy)
    MW->>DB: query (unchanged SQL)
    DB-->>EX: rows
    EX-->>FL: SAME response body / status / headers
    MW-->>SH: (async, sampled) mirror inputs to Identity/Ratelimit shadows
    Note over SH: shadow computes + compares; NEVER affects the response
```

The served path is identical to today. Kernel involvement is strictly a side-channel
(dashed), so no route or response can change — satisfying the phase's hard compatibility
rules.

---

## 3. Lifecycle Ownership (boot & shutdown)

```mermaid
stateDiagram-v2
    [*] --> Composing: bootstrap()
    Composing --> Verifying: createPlatform() (25 kernels, dep order)
    Verifying --> Starting: verifyStartup() OK
    Starting --> KernelsReady: platform.start() (lifecycle-ordered)
    KernelsReady --> AppStarting: host.register(OnCallAppService)
    AppStarting --> Serving: migrations → stores → listen → sockets → timers
    Serving --> Draining: SIGTERM / SIGINT
    Draining --> Stopped: io.close → server.close (≤10s) → lifecycle reverse-stop
    Stopped --> [*]
    Serving --> Serving: /health, /health/ready unchanged
```

The app's original ordering constraint — **migrations before `server.listen`** — becomes the
hosted service's `start()` contract, now enforced by Host + Lifecycle instead of statement
order, with identical observable results and identical shutdown behavior.

---

## 4. Rollback View (every coupling is a flag)

```mermaid
flowchart LR
    ALL["PLATFORM_ENABLED=0"] --> A["Standalone server.js (today)"]
    HOSTF["PLATFORM_HOST=0"] --> B["IIFE boot, no host wrapper"]
    CFGF["PLATFORM_CONFIG=0"] --> C["env.js direct"]
    OBSF["PLATFORM_OBS=0"] --> D["legacy metrics source"]
    JOBF["PLATFORM_JOBS=0"] --> E["legacy setInterval timers"]
    SHF["SHADOW_*=0"] --> F["no shadow, zero impact"]
```

Any box on the right is reachable by a single flag flip + restart — no code change, no
migration, no client impact.
