# Phase 17.4 — Updated Integration Diagram

End-state: the OnCall backend runs unchanged as the Hosted Service (17.2). **Two** adapters are
now connected in shadow mode — Configuration (17.3) and Observability (17.4) — each a read-only
side channel that compares values and always returns the legacy result. All other kernels
remain composed-but-not-consumed.

---

## 1. Shadow data flow (observability)

```mermaid
flowchart TB
    subgraph APP["OnCall application (UNCHANGED)"]
        LEGOBS["Legacy observability: getMetrics() + /health/*"]
        RTS["routers · middleware · socket · services · repos"]
    end

    subgraph SHADOW["Observability Shadow (out-of-band, read-only)"]
        LEG["legacySource.observe()"]
        SV["verify() / shadowObserve()"]
        MET["shadow metrics (isolated)"]
    end

    subgraph ADAPT["Platform Adapter Layer"]
        OA["Observability Adapter (consumed)"]
        CA["Configuration Adapter (consumed, 17.3)"]
        OTH["10 other adapters — INERT"]
    end

    subgraph PLAT["Enterprise Platform"]
        OK["Observability Kernel (ADR-033)"]
        CK["Config Kernel (ADR-019)"]
        REST["other kernels — composed, NOT consumed"]
    end

    RTS -->|serves| LEGOBS
    LEGOBS -->|authoritative| SV
    LEG --> SV
    SV -->|"record + read-back (only)"| OA -->|port| OK
    SV --> MET
    SV ==>|returns LEGACY result| LEG
    OK -. "view used only in compare, never exposed" .- SV

    classDef inert fill:#eee,stroke:#bbb,color:#666;
    class OTH,REST inert;
```

## 2. Request / observability path (unchanged — proves zero client impact)

```mermaid
sequenceDiagram
    participant K8s as Probe / Prometheus
    participant EX as Express (unchanged)
    participant OBS as legacy /metrics + /health/* (unchanged)
    participant SH as Observability shadow (out-of-band)

    K8s->>EX: GET /metrics or /health/*
    EX->>OBS: legacy handler (unchanged)
    OBS-->>K8s: SAME body / status / headers
    Note over SH: verify() ran once at boot; not on the request path
```

## 3. Flag-gated states

```mermaid
flowchart LR
    A["PLATFORM_OBSERVABILITY=0 (default)"] --> A1["adapter INERT · identical to 17.3"]
    B["PLATFORM_OBSERVABILITY=1, SHADOW_OBSERVABILITY=0"] --> B1["kernel wired · NO comparisons"]
    C["PLATFORM_OBSERVABILITY=1, SHADOW_OBSERVABILITY=1"] --> C1["parity comparisons run · legacy still wins"]
```

## 4. Progress across Phase 17.x

```mermaid
flowchart LR
    P172["17.2 Hosted Service"] --> P173["17.3 Config shadow"] --> P174["17.4 Observability shadow"]
    P174 -. next .-> NEXT["(future single-kernel shadows)"]
    classDef done fill:#e6ffe6,stroke:#39a039;
    class P172,P173,P174 done;
```

Two dashed links from the 17.1 target are now live — **Configuration → Config Kernel** and
**Observability → Observability Kernel** — both strictly read-only/shadow. Every other adapter
is inert and every other kernel is composed-but-not-consumed. The app request path and all
observability surfaces are byte-for-byte the 17.3 path.
