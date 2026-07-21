# Phase 17.2 — Updated Architecture Diagram

End-state of Phase 17.2: the unchanged OnCall backend runs as a single Hosted Service under
the Enterprise Host/Runtime. The Platform Adapter Layer exists as the sole application↔kernel
seam but is **inert** (no kernel consumed).

---

## 1. Component & control-flow view

```mermaid
flowchart TB
    subgraph ENTRY["server.js (88-line launcher)"]
        MODE["selectBootMode(env)"]
    end

    subgraph LEGACYPATH["LEGACY mode (default)"]
        L1["createOnCallApplication()"]
        L2["application.start()"]
        L3["verbatim SIGTERM/SIGINT shutdown"]
    end

    subgraph ENTPATH["ENTERPRISE mode (PLATFORM_ENABLED=1, PLATFORM_HOST=1)"]
        E1["bootEnterprise()"]
        subgraph DEP["Deployment (ADR-045) — available, optional"]
        end
        subgraph HOST["Host (ADR-044)"]
            HS["OnCallAppService (§2 contract)"]
        end
        subgraph RT["Runtime (ADR-043)"]
            RUN["bootstrap(): compose→verify→start"]
        end
        subgraph PLAT["Platform (ADR-042)"]
            K["25 kernels — memory providers, INERT"]
        end
    end

    subgraph APP["OnCall application (UNCHANGED, shared by both modes)"]
        AX["createOnCallApplication()"]
        MW["middleware: setup·auth·rateLimiter·metrics"]
        RTS["routers: src/routes/* + src/presentation/api/*"]
        SK["src/socket.js (Socket.IO)"]
        SV["services + repositories"]
        DB["src/config/database.js (SQLite WAL / PG)"]
    end

    subgraph ADAPT["src/platform-adapters/ (INERT in 17.2)"]
        A12["12 translators + index.js — consumed() = []"]
    end

    MODE -->|legacy| L1 --> L2 --> AX
    MODE -->|enterprise| E1
    E1 --> RUN --> K
    E1 --> HS
    HS -->|start/stop| AX
    L3 -. controls .- AX

    AX --> MW --> RTS
    AX --> SK
    RTS --> SV --> DB

    HS -. holds (unused) .- A12
    A12 -. "future: ports only" .- K
```

Solid arrows are live control/data flow. The dotted `OnCallAppService ⇢ adapters ⇢ kernels`
path is present but carries nothing in 17.2 — every adapter is inert.

## 2. Layer stack (Enterprise mode)

```mermaid
flowchart TD
    D["Deployment (ADR-045) — optional, ops"] --> H["Host (ADR-044)"]
    H --> R["Runtime (ADR-043)"]
    R --> P["Platform (ADR-042) — 25 kernels, inert"]
    H --> S["OnCallAppService (the ONE hosted service)"]
    S --> APP["OnCall application (Express + Socket.IO + SQLite/PG), UNCHANGED"]
    S -. inert seam .- AD["Platform Adapter Layer (12 adapters)"]
```

## 3. Request path (unchanged — proves zero client impact)

```mermaid
sequenceDiagram
    participant FL as Flutter
    participant EX as Express (unchanged routers)
    participant MW as auth + rateLimiter (unchanged)
    participant DB as db helpers (SQLite/PG)

    FL->>EX: HTTP request (same route)
    EX->>MW: authenticate + rate limit (verifyJWT, unchanged)
    MW->>DB: query (unchanged SQL)
    DB-->>EX: rows
    EX-->>FL: SAME status / headers / body
    Note over FL,DB: No adapter, no kernel touches the request in Phase 17.2.
```

## 4. Mode switch (rollback = flag)

```mermaid
flowchart LR
    A["PLATFORM_ENABLED=1 AND PLATFORM_HOST=1"] --> ENT["Enterprise: host-managed lifecycle"]
    B["either flag unset / not '1'"] --> LEG["Legacy: standalone server.js (default)"]
```

## 5. What changed vs Phase 17.1 diagram
- 17.1 was a **plan** (adapters described as future "shadows"). 17.2 **implements** the Host
  wrapping and the adapter layer, but keeps every adapter **inert** — no shadow traffic, no
  kernel consumption. The dashed kernel links from the 17.1 target are intentionally **not**
  active yet; they arrive one at a time in later phases via injected ports.
