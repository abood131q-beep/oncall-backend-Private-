# Phase 17.6 — Updated Integration Diagram

End-state: the OnCall backend runs unchanged as the Hosted Service (17.2). **Four** adapters are
now connected in shadow mode — Configuration (17.3), Observability (17.4), Jobs (17.5),
Scheduler (17.6) — each read-only, non-authoritative, returning legacy results. Jobs and
Scheduler additionally **never execute / never own a timer**. All other kernels remain
composed-but-not-consumed.

---

## 1. Shared framework (post-generalization)

```mermaid
flowchart TB
    subgraph FW["src/platform-adapters/_shadow (shared, G1.0 §7)"]
        CORE["core.js — deepEqual · flatten · redactValue · createShadowMetrics (confidence + coverage)"]
        RT["roundTripShadow.js — createRoundTripShadow (generic: record → readRef → compare)"]
    end
    JOBS["jobs/shadow.js (thin config)"] --> RT
    SCHED["scheduler/shadow.js (thin config)"] --> RT
    RT --> CORE
    CFG["configuration/shadow.js (pre-G1.0, own copy)"] -. may adopt later .- CORE
    OBS["observability/shadow.js (pre-G1.0, own copy)"] -. may adopt later .- CORE
```

Jobs and Scheduler share ONE verify algorithm; the legacy timer inventory has ONE source.

## 2. Scheduler shadow data flow

```mermaid
flowchart TB
    subgraph APP["OnCall application (UNCHANGED)"]
        TIMERS["Legacy scheduler: setInterval timers + startup cleanup — owns timing, produces work"]
    end

    subgraph SHADOW["Scheduler Shadow (out-of-band, read-only, NEVER start()/tick())"]
        LEG["legacySource.list() (5 schedules)"]
        SV["verify() (record → readRef → compare) [generic]"]
        MET["shared shadow metrics"]
    end

    subgraph ADAPT["Platform Adapter Layer"]
        SA["Scheduler Adapter (consumed)"]
        JA["Jobs Adapter (17.5)"]
        CA["Configuration Adapter (17.3)"]
        OA["Observability Adapter (17.4)"]
        OTH["8 other adapters — INERT"]
    end

    subgraph PLAT["Enterprise Platform"]
        SK["Scheduler Kernel (ADR-020) — schedules placed, NEVER started/ticked"]
        REST["other kernels — composed, NOT consumed"]
    end

    TIMERS -->|owns timing / all work| APP
    LEG --> SV
    SV -->|"scheduleRecurring/At (only)"| SA -->|port| SK
    SV --> MET
    SV ==>|returns LEGACY behavior| LEG
    SK -. "read for compare; never started / executed / exposed" .- SV

    classDef inert fill:#eee,stroke:#bbb,color:#666;
    class OTH,REST inert;
```

## 3. Non-ownership / non-execution

```mermaid
sequenceDiagram
    participant SH as Scheduler shadow (boot, once)
    participant AD as Scheduler Adapter
    participant SK as Scheduler Kernel
    SH->>AD: record(descriptor)
    AD->>SK: scheduleRecurring({name,owner,handler:NOOP}, {intervalMs})   %% status = 'scheduled'
    AD-->>SH: { jobId }
    SH->>AD: readRef({jobId})
    AD->>SK: jobSnapshot(jobId)                                          %% read only
    Note over SH,SK: start() and tick() are NEVER called ⇒ no timer armed, 0 executions
```

## 4. Progress across Phase 17.x

```mermaid
flowchart LR
    P172["17.2 Host"] --> P173["17.3 Config"] --> P174["17.4 Observability"] --> G1["G1.0"] --> P175["17.5 Jobs"] --> P176["17.6 Scheduler"]
    classDef done fill:#e6ffe6,stroke:#39a039;
    class P172,P173,P174,G1,P175,P176 done;
```

Four dashed links from the 17.1 target are now live (Config, Observability, Jobs, Scheduler),
all read-only shadows. Scheduler is the second integration under G1.0 and the first to **reuse
and extend** the shared framework (generic verifier + shared timer inventory). Every other
adapter stays inert; every other kernel is composed-but-not-consumed; the app request path and
legacy scheduler are unchanged.
