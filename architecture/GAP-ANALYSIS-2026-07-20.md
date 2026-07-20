# OnCall — Global Engineering Gap Analysis

**Chief Software Architect · 2026-07-20 · READ-ONLY audit (nothing implemented)**
**Method:** every status is traced to actual code in the repository. Documentation was
ignored as evidence; only files/functions/routes/tests count. Scores are conservative.

Legend: ✅ Complete · 🟡 Partial · ❌ Missing · score 0–10.

---

## 1. Architecture

| Item | Status | Evidence | Score |
|---|---|---|---|
| Clean Architecture | ✅ | `src/{domain,application,infrastructure,presentation}` across 14 contexts; 121 layer files; verifier: 0 Express outside presentation, 0 SQL in domain/application | 9 |
| Domain-Driven Design | ✅ | bounded contexts as dirs; aggregates (`Trip.js`,`Commerce.js`,`Scooter.js`,`User.js`), policies, value objects (`*Values.js`) | 9 |
| Event-Driven Architecture | 🟡 | Socket.IO emits domain-ish events (`trip:updated`,`new:trip`) in `src/socket.js`; **no event bus / no domain-event dispatcher** in app/domain layers (grep for eventBus/publish = none) | 4 |
| CQRS | 🟡 | commands separated (`application/*/commands.js`) and read-model adapters exist (`scooterReadModelAdapter.js`); but same store, no command/query bus — conceptual split only | 6 |
| Repository Pattern | ✅ | `src/repositories/*` + `infrastructure/repositories/*Adapter.js` behind ports | 9 |
| Dependency Injection | ✅ | factory injection everywhere (`createXApplication(ports)`, `assertPorts`); 10 `application/*/index.js` composition roots | 9 |
| Plugin System | ❌ | no plugin loader/registry in code | 0 |
| Feature Flags | 🟡 | per-context `*_LEGACY` rollback env flags in `server.js`; `PAYMENT_ENABLED`; **no general flag service** (no audience/%/cohort) | 4 |
| Multi-Tenant | ❌ | grep tenant/organization_id/orgId in src = **none**; Organization is an ADR concept only, not in code | 1 |
| ADR Documentation | ✅ | `docs/ADR-001..015` + amendments + `architecture/ADR/ADR-002..005` | 10 |

## 2. Backend

| Item | Status | Evidence | Score |
|---|---|---|---|
| Authentication | ✅ | `src/middleware/auth.js`, `application/identity/useCases.js`; A/B identity 35 scenarios | 9 |
| Authorization | ✅ | `authenticate/authenticateDriver/authenticatePassenger/authenticateAdmin` | 9 |
| JWT | ✅ | `generateJWT/verifyJWT` in `auth.js` | 9 |
| Refresh Tokens | ✅ | `generateRefreshToken/verifyRefreshToken/revokeRefreshToken` + rotation; unit + A/B proven (rotation, replay-401) | 9 |
| RBAC | ✅ | role capability + ownership + admin-phone gates; A/B across admin/drivers | 8 |
| REST API | ✅ | 99 distinct routes across `src/routes` + `src/presentation/api` | 9 |
| WebSocket | ✅ | `src/socket.js`, 9 event types, JWT-authed | 8 |
| Background Jobs | 🟡 | `startBackupSchedule`, cache TTL sweeps, rate-limit cleanup via `setInterval`; **no job queue/worker** | 5 |
| Scheduler | 🟡 | in-process intervals only + external `backup/crontab`; no app-level scheduler abstraction | 5 |
| File Storage | ❌ | no multer/S3/object-store code (grep = none) | 0 |
| Configuration | ✅ | `src/config/env.js` single source + P6-04 production guards | 9 |
| Logging | ✅ | `src/utils/logger.js` (levels, rotation, security stream) | 8 |
| Validation | ✅ | 3-tier: command input validation + domain policies; `helpers.js` validators | 8 |

## 3. Mobility Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| Taxi | ✅ | `application/trips`, `routes/taxi.js`, A/B trips 31/31 | 9 |
| Scooters | ✅ | `domain/scooters/*`, `application/scooters`, A/B 24/24 | 9 |
| Drivers | ✅ | `application/drivers`, approval lifecycle, A/B green | 9 |
| Fleet | ✅ | `application/fleet`, `presentation/api/fleetController.js`, A/B 14/14 | 8 |
| Pricing | 🟡 | `fareCalculator.js` + commerce values; **single FARE_CONFIG, not per-city authored rules** (ADR-003 target unbuilt) | 6 |
| Payments | ✅ | `application/payments` + `application/commerce`, wallet/cash, A/B 15/15; C-1 atomic settlement (ADR-001) | 8 |
| Promotions | ❌ | no promotion/campaign/discount/coupon domain in code (grep = none in domain) | 0 |
| Booking | 🟡 | booking intent fused into trip request (`routes/taxi.js`); no separate Booking aggregate (ADR-002 target) | 5 |
| Ride Lifecycle | ✅ | trip state machine in `domain/trips/tripPolicies.js`; states waiting→accepted→arrived→in_progress→completed/cancelled | 9 |

## 4. IoT Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| GPS | 🟡 | driver/scooter lat/lng stored + `driver:location` socket events; consumed, not a device-telemetry pipeline | 5 |
| Telemetry | ❌ | no telemetry ingestion pipeline; `infrastructure/mqtt/` is an **empty .gitkeep dir** | 1 |
| Battery Monitoring | 🟡 | `battery` column on scooters (`ScooterRepository.js`), set on writes; no live device feed | 3 |
| Geofencing | ❌ | no geofence/zone-rule engine in code | 0 |
| Remote Lock | 🟡 | scooter unlock/lock is a **state change in DB**, not a device command (no hardware gateway) | 3 |
| OTA Firmware | ❌ | none | 0 |
| Device Registry | ❌ | `device_tokens` = push tokens, not a vehicle-device registry | 1 |
| Vehicle Twin | ❌ | none | 0 |
| Anti-Theft | ❌ | none | 0 |

**IoT is the platform's largest genuine gap** — it is essentially a data-model-only vertical
today; there is no device/hardware integration layer (the mqtt dir is empty).

## 5. AI Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| Dispatch Optimization | 🟡 | `driverMatcher.js` = deterministic proximity match (not AI, but functional) | 5 |
| ETA Prediction | ❌ | no ETA model; maps provider advisory only | 1 |
| Dynamic Pricing | ❌ | no dynamic/surge pricing engine | 0 |
| Demand Forecasting | ❌ | none | 0 |
| Fraud Detection | ❌ | none | 0 |
| Operations Copilot | ❌ | none | 0 |
| (AI framework) | 🟡 | `domain/ai` + `infrastructure/ai/aiProviderAdapter.js` exist but **provider is intentionally disabled** (`isConfigured:()=>false`, `infer()` throws) — honest scaffold per ADR-011, zero live intelligence | 3 |

## 6. Cloud Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| PostgreSQL | 🟡 | `infrastructure/db/postgresAdapter.js` + `sqlDialect.js` (unit-tested) behind `DB_ENGINE`; **live-PG A/B gate never run** (`engine-ab.mjs` fails-closed) | 6 |
| Redis | 🟡 | `infrastructure/scaling/redisState.js` wired in `server.js` behind `REDIS_URL`, **default-off & unverified**; lazy-loaded, no live proof | 4 |
| Docker | ✅ | multi-stage `Dockerfile`, `docker-compose.prod.yml` (4 svc) | 9 |
| Kubernetes | 🟡 | `k8s/deployment.yaml` with liveness/readiness/startup probes; single manifest, no full chart/kustomize | 5 |
| Service Mesh | ❌ | none | 0 |
| Message Broker | ❌ | none (Redis pub/sub for revocations only, off by default) | 1 |
| Event Streaming | ❌ | none (no Kafka/streams) | 0 |
| Object Storage | ❌ | none | 0 |
| CDN | ❌ | none (nginx static-cache template only) | 1 |
| Multi-Region | ❌ | none in code (design-only in ADRs) | 0 |

## 7. Security

| Item | Status | Evidence | Score |
|---|---|---|---|
| Zero Trust | 🟡 | per-request authz + default-deny gates; not a full mTLS/identity-mesh | 6 |
| Secrets Management | ✅ | file-based Docker secrets (`secrets/`), git-ignored, `*_FILE` pattern; never in backups | 8 |
| WAF | ❌ | none (helmet ≠ WAF) | 1 |
| DDoS Protection | 🟡 | per-IP + per-phone rate limiting (`rateLimiter.js`); no edge/network DDoS layer | 4 |
| Encryption | 🟡 | backups gpg-AES256 (`backup/backup.sh`); TLS at nginx; **no app-level field encryption / at-rest DB encryption** | 6 |
| Audit Logs | 🟡 | `driver_approval_logs`, security log stream; not a unified tamper-evident audit fabric | 6 |
| Security Monitoring | 🟡 | Prometheus + `logger.security()`; no SIEM/alerting-on-security-events wired | 5 |

## 8. Data Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| Analytics | 🟡 | `services/analytics.js` + admin `analytics()`/`revenue()`/`stats()` — operational aggregates only | 5 |
| BI | ❌ | none | 0 |
| Data Lake | ❌ | none | 0 |
| Data Warehouse | ❌ | none | 0 |
| Event Store | ❌ | none (facts in relational tables, not an event store) | 1 |
| Reporting | 🟡 | admin stats/revenue endpoints; no scheduled/exportable report engine | 4 |

## 9. Developer Platform

| Item | Status | Evidence | Score |
|---|---|---|---|
| SDK | 🟡 | `tools/oncall-mcp` (101 TS MCP tools) = an internal SDK-of-sorts; no public client SDK | 3 |
| GraphQL | ❌ | none | 0 |
| Webhooks | ❌ | none (grep = only the word in payment.js comments) | 0 |
| API Marketplace | ❌ | none | 0 |
| Developer Portal | ❌ | none | 0 |
| OpenAPI Documentation | ❌ | no openapi/swagger spec in repo | 0 |

## 10. DevOps

| Item | Status | Evidence | Score |
|---|---|---|---|
| CI/CD | ✅ | `.github/workflows/` (ci, quality, docker-release, deploy, emergency-rollback, release-please) | 9 |
| Automated Tests | ✅ | **194 unit** (14 files) + **11 A/B harnesses** | 9 |
| Load Testing | ❌ | no load-test script/tool in repo (no k6/autocannon/artillery) | 0 |
| Monitoring | ✅ | `docker-compose.monitoring.yml` (Prometheus/Grafana/exporters), `routes/observability.js` | 8 |
| Alerting | ✅ | `monitoring/prometheus/alerts.yml` (8 rules) | 7 |
| Backups | ✅ | `backup/` agent, encrypted, tiered, auto restore-test | 9 |
| Disaster Recovery | ✅ | `docs/DISASTER_RECOVERY_RUNBOOK.md` + tested restore; off-site sync documented not wired | 7 |
| Blue/Green Deployment | 🟡 | `deploy-release.sh` blue-green path (candidate-validate-then-swap) | 6 |
| Canary Deployment | 🟡 | `deploy-release.sh` canary with weighted nginx upstream + bake | 6 |

---

## Aggregate Scores (evidence-weighted, conservative)

| Dimension | Score | Basis |
|---|---|---|
| **Overall Platform Maturity** | **62%** | strong core (arch/backend/mobility/devops) dragged down by empty IoT, absent AI, thin data/dev-platform |
| **Production Readiness** | **72%** | app layer green (194 unit + 10 A/B); blocked on live PG/Redis gates, load tests, and Node-24 native build |
| **Global Scalability** | **45%** | single-writer SQLite default; Redis/PG paths built-but-unverified; no multi-region/streaming/mesh |
| **Security Score** | **68%** | authz/secrets/refresh/encryption-of-backups solid; no WAF, no unified audit, no at-rest DB encryption |
| **Architecture Score** | **88%** | Clean Architecture + DDD + DI mechanically verified; loses points for missing event bus / true CQRS bus / multi-tenant |

---

## Top 20 Highest-Priority Engineering Gaps (by impact)

1. **PostgreSQL live gate unproven** — `engine-ab.mjs` never run vs real PG; scalability ceiling until closed.
2. **Node-24 native `sqlite3` build broken on target** — blocks migrate/test/boot locally (environment, but blocks shipping).
3. **Redis wired but unverified** — multi-instance revocation/cache/socket-adapter default-off, no live proof; blocks horizontal scale.
4. **Multi-tenant absent** — no Organization/tenant scoping in code; blocks B2B/fleet-operator model.
5. **IoT device layer missing** — empty `mqtt/`; no telemetry/geofence/remote-lock/OTA; scooter "lock" is a DB flag.
6. **Promotions missing entirely** — no campaign/discount domain; growth-critical.
7. **Load/performance testing absent** — zero measured req/s, P95/P99; production capacity unknown.
8. **Event bus / domain-event dispatcher missing** — cross-context integration rides Socket.IO + direct calls, not events.
9. **Booking not separated from Trip** — ADR-002 target unbuilt; blocks scheduled rides / multi-modal.
10. **Pricing not per-city authored data** — single FARE_CONFIG; blocks market localization.
11. **OpenAPI spec missing** — no machine contract; blocks SDK/contract tests/dev portal.
12. **AI capabilities all absent/disabled** — dispatch is deterministic; no ETA/surge/forecast/fraud.
13. **No unified tamper-evident audit fabric** — partial logs only; compliance risk.
14. **WAF / edge DDoS absent** — only app-level rate limiting.
15. **Object storage / file storage missing** — no path for documents, driver licenses, vehicle photos.
16. **At-rest DB encryption absent** — only backups encrypted.
17. **Data warehouse / event store / BI absent** — analytics is operational aggregates only.
18. **Webhooks / developer platform absent** — no partner integration surface.
19. **K8s is a single manifest** — no Helm/kustomize, no HPA/secrets/ingress objects for real cluster ops.
20. **Feature-flag service is env-flag-only** — no runtime/audience/percentage rollout control.

---

## Recommended Roadmap — Phase 14 onward

- **Phase 14 — Close the substrate gates (highest ROI, lowest risk):** promote a native-free
  `node-sqlite` engine OR fix the Node-24 native build; run the live **PostgreSQL A/B gate**; verify
  **Redis** (revocation propagation, socket adapter, cache) against a real server; add a load-test
  harness and capture the first P95/P99 baseline. *Turns "built" into "proven."*
- **Phase 15 — Multi-tenancy & Organizations:** implement the Organization aggregate + tenant scoping
  (ADR-002) — unlocks fleet operators and the B2B model; touches authz + every repository's scope key.
- **Phase 16 — Commerce depth:** Promotions domain + per-city authored Pricing + Booking-as-its-own-
  aggregate (scheduled rides). All additive behind the existing contracts.
- **Phase 17 — Event backbone:** introduce a real domain-event dispatcher (in-proc first, broker-ready)
  so contexts integrate by events, not calls — precondition for streaming/analytics later.
- **Phase 18 — IoT vertical (largest build):** device registry + telemetry ingestion + geofencing +
  real remote-lock gateway; the mqtt seam already exists as an empty placeholder.
- **Phase 19 — Data & Security platform:** event store → warehouse/BI; unified audit fabric; at-rest
  encryption; WAF/edge protections.
- **Phase 20 — Developer platform & AI:** OpenAPI spec → client SDK + webhooks + portal; then enable
  the AI provider (ETA/dispatch/fraud) that ADR-011 scaffolded and deliberately left disabled.

---

*Every ✅/🟡/❌ above corresponds to code I traced this session. Items marked ❌ were confirmed absent
by grep across `src/`, not inferred. Scores are deliberately conservative; documentation was not
counted as implementation.*
