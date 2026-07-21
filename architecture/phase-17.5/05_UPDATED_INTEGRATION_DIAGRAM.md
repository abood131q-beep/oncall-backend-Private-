# Phase 17.5 — Updated Integration Diagram

End-state: the OnCall backend runs unchanged as the Hosted Service (17.2). **Three** adapters
are now connected in shadow mode — Configuration (17.3), Observability (17.4), Jobs (17.5) —
each read-only, non-authoritative, returning legacy results. Jobs additionally **never
executes**. All other kernels remain composed-but-not-consumed.

---

## 1. Shadow data flow (jobs)

```mermaid
flowchart TB
    subgraph APP["OnCall application (UNCHANGED)"]
        TIMERS["Legacy scheduler: setInterval timers + startup cleanup"]
        RTS["routers · middleware · socket · services · repos"]
    end

    subgraph SHADOW["Jobs Shadow (out-of-band, read-only, NEVER ticks)"]
        LEG["legacySource.list() (5 job descriptors)"]
        SV["verify()  (record → readJob → compare)"]
        MET["shared shadow metrics (parity/confidence/coverage)"]
    end

    subgraph ADAPT["Platform Adapter Layer"]
        JA["Jobs Adapter (consumed)"]
        CA["Configuration Adapter (17.3)"]
        OA["Observability Adapter (17.4)"]
        OTH["9 other adapters — INERT"]
    end

    subgraph PLAT["Enterprise Platform"]
        JK["Jobs Kernel (ADR-032) — definitions placed, NEVER ticked"]
        CK["Config Kernel (ADR-019)"]
        OK["Observability Kernel (ADR-033)"]
        REST["other kernels — composed, NOT consumed"]
    end

    TIMERS -->|produces ALL work| RTS
    LEG --> SV
    SV -->|"register no-op + schedule (only)"| JA -->|port| JK
    SV --> MET
    SV ==>|returns LEGACY behavior| LEG
    JK -. "definitions read for compare; never executed / exposed" .- SV

    classDef inert fill:#eee,stroke:#bbb,color:#666;
    class OTH,REST inert;
```

## 2. Non-execution (the defining safety property)

```mermaid
sequenceDiagram
    participant SH as Jobs shadow (boot, once)
    participant AD as Jobs Adapter
    participant JK as Jobs Kernel

    SH->>AD: record(descriptor)
    AD->>JK: register({type, handler: NOOP})
    AD->>JK: schedule({type, delayMs, payload})   %% status = 'scheduled'
    AD-->>SH: { jobId }
    SH->>AD: readJob(jobId)
    AD->>JK: status(jobId)                          %% read only
    Note over SH,JK: tick() is NEVER called ⇒ the NOOP handler never runs ⇒ 0 jobs executed
```

## 3. Flag-gated states

```mermaid
flowchart LR
    A["PLATFORM_JOBS=0 (default)"] --> A1["adapter INERT · identical to 17.4"]
    B["PLATFORM_JOBS=1, SHADOW_JOBS=0"] --> B1["kernel wired · NO comparisons"]
    C["PLATFORM_JOBS=1, SHADOW_JOBS=1"] --> C1["parity comparisons run · legacy still owns work"]
```

## 4. Progress across Phase 17.x

```mermaid
flowchart LR
    P172["17.2 Hosted Service"] --> P173["17.3 Config"] --> P174["17.4 Observability"] --> G1["G1.0 Standard"] --> P175["17.5 Jobs"]
    classDef done fill:#e6ffe6,stroke:#39a039;
    class P172,P173,P174,G1,P175 done;
```

Three dashed links from the 17.1 target are now live (Config, Observability, Jobs), all
read-only shadows. Jobs is the first integration authored under **G1.0** and introduces the
shared shadow framework future kernels reuse. Every other adapter stays inert; every other
kernel is composed-but-not-consumed; the app request path and legacy scheduler are unchanged.
