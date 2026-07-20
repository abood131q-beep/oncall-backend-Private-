# Evidence Mapping — ADR Requirement → Proof

**Repository state after Phase 11 (Commerce Migration) — MIGRATION PROGRAM COMPLETE (11/11)** · **Date:** 2026-07-20
_(Living document — updated every phase; originated in Phase 3.5 Architecture Governance.)_

Every architectural claim in this repository must reference evidence. This document maps ADR
requirements to the implementation files, migration phase, tests, reports, and mechanical proof
that substantiate them. Where a requirement is not yet met, the row says **(gap)** and points to
the tracking ADR/debt.

## Legend
- **Src** = source files · **Phase** = migration phase that delivered it · **Test** = automated proof · **Report** = written record · **Proof** = mechanical/live verification

---

## ADR-002 — Domain Model (bounded contexts, aggregates)
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| Identity aggregate + policies (pure) | `src/domain/identity/loginPolicy.js`, `src/domain/shared/Phone.js` | 2 | `tests/unit/identity.test.js` | `architecture/MIGRATION-PHASE-2.md` |
| User aggregate + VOs + policies (pure) | `src/domain/users/User.js`, `profileValues.js`, `userPolicies.js` | 3 | `tests/unit/users.test.js` | `architecture/MIGRATION-PHASE-3.md` |
| Driver aggregate + status/availability VOs + approval policies (pure) | `src/domain/drivers/{Driver,driverValues,driverPolicies}.js` | 4 | `tests/unit/drivers.test.js` | `architecture/MIGRATION-PHASE-4-DRIVERS.md` |
| Scooter aggregate + Status/Battery/Code/Availability VOs + Unlock/Lock/Availability/Battery policies (pure) | `src/domain/scooters/{Scooter,scooterValues,scooterPolicies}.js` | 5 | `tests/unit/scooters.test.js` | `architecture/MIGRATION-PHASE-5-SCOOTERS.md` |
| Notification aggregate + Status/Type/DeliveryChannel VOs + Delivery/Retry/Read/Visibility policies (pure) | `src/domain/notifications/{Notification,notificationValues,notificationPolicies}.js` | 6 | `tests/unit/notifications.test.js` | `architecture/MIGRATION-PHASE-6-NOTIFICATIONS.md` |
| Trip aggregate + Status/Id/Pickup/Destination VOs + Assignment/Acceptance/Cancellation/Completion/StateTransition policies (pure) | `src/domain/trips/{Trip,tripValues,tripPolicies}.js` | 7 | `tests/unit/trips.test.js` | `architecture/MIGRATION-PHASE-7-TRIPS.md` |
| Single ownership per capability | `src/application/{identity,users}/useCases.js` | 2–3 | A/B parity | verifier R4/R5 |
| Geography/Market/Jurisdiction entities | **(gap)** | — | — | ADR-002-A001, ADR-003-A001 (Planned) |

## ADR-003 — Globalization & Localization
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| Locale value object | `src/domain/users/profileValues.js` (`tryCreateLocale`), `src/domain/localization/localePolicy.js` | 3 / 3.5 | `tests/unit/localization.test.js` | i18n live proof (ar identical / en / fr→ar) |
| Locale-driven message catalog + fallback chain | `src/domain/localization/messageCatalog.js` | 3.5 | `tests/unit/localization.test.js` | Users A/B 17/17 (default `ar` byte-identical) |
| `Accept-Language` negotiation | `src/application/localization/index.js`, `src/presentation/api/usersController.js` | 3.5 | live i18n harness | — |
| Drivers Arabic-default / English-additive rejection messages | `src/presentation/api/driversController.js` | 4 | Drivers A/B 14/14 (Arabic default) | `MIGRATION-PHASE-4-DRIVERS.md` |
| RTL-native / Arabic first-class | default locale `ar` | 3.5 | — | catalog `ar` = frozen strings |
| Country/currency/tax cascade | **(gap)** | — | — | ADR-003 §cascade (Planned) |

## ADR-004 — Data Architecture (facts/state/derivation)
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| Append-only financial ledger (facts) | `src/repositories/WalletRepository.js` (`logTransaction`) | legacy | `tests/unit/repositories.test.js` | — |
| Append-only approval audit log | `src/repositories/DriverRepository.js` (`logApprovalAction`), `driver_approval_logs` | P6-06 | E2E approval | P6-06 report |
| Driver read models + approval audit adapter | `src/infrastructure/repositories/{driverRepositoryAdapter,driverReadModelAdapter}.js` | 4 | Drivers unit + A/B 14/14 | `MIGRATION-PHASE-4-DRIVERS.md` |
| Effective revocation records (facts) | `src/middleware/auth.js` revocation store | P6-01 | identity A/B | MIGRATION-PHASE-2 |
| Read models / derivations disposable | `src/infrastructure/repositories/userReadModelAdapter.js` | 3 | `tests/unit/users.test.js` | verifier R2 (no SQL leak) |
| Postgres cutover / data-class governance | `docker-compose.prod.yml` (postgres:17 provisioned, **not consumed**) | — | — | ADR-001 + G0.0 G3 (Planned) |

## ADR-005 — Application Architecture (layers, use cases, tx boundary)
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| Five layers, one-way dependency | `src/{domain,application,infrastructure,presentation}/**` | 2–3.5 | — | **verifier R1–R6 PASS (26 files)** |
| Drivers five-layer migration + fail-fast ports | `src/{domain,application,infrastructure,presentation}/drivers/**` | 4 | `tests/unit/drivers.test.js` | verifier R1–R7 PASS (40 files) |
| Ports defined by Application, implemented by Infra | `src/application/*/ports.js`, `src/infrastructure/**` | 2–3 | `assertPorts` fail-fast | verifier R7 |
| Command = one transaction boundary | `src/config/database.js` (`dbTransaction` serialized) | C-1 fix | C-1 concurrency live test | ADR-001 (full isolation Planned) |
| Gates before domain logic | `src/application/users/useCases.js` (`balanceReadAuthorization` first) | 3 | `tests/unit/users.test.js` | — |
| Typed results, no exceptions for control flow | all `useCases.js` (`{ok,value}`/`{ok:false,code}`) | 2–3 | unit suites | — |

## ADR-006 — Integration Architecture (contracts, events)
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| Frozen REST/JSON contract | `src/presentation/api/*` | 2–3 | **A/B harnesses (35/35, 17/17)** | MIGRATION-PHASE-2/3 |
| Drivers frozen REST/JSON contract | `src/presentation/api/drivers{Routes,Controller}.js` | 4 | **Drivers A/B 14/14** | `MIGRATION-PHASE-4-DRIVERS.md` |
| Scooters frozen REST/JSON contract (11 endpoints) | `src/presentation/api/scooters{Routes,Controller}.js` | 5 | **Scooters A/B 24/24** | `MIGRATION-PHASE-5-SCOOTERS.md` |
| Notifications frozen REST/JSON contract (5 endpoints; SQL relocated to Infra) | `src/presentation/api/notifications{Routes,Controller}.js`, `src/infrastructure/repositories/deviceTokenAdapter.js` | 6 | **Notifications A/B 21/21** | `MIGRATION-PHASE-6-NOTIFICATIONS.md` |
| Trips frozen REST/JSON contract (16 endpoints; matcher/payment/socket reused via gateways) | `src/presentation/api/trips{Routes,Controller}.js`, `src/infrastructure/gateways/tripGateways.js` | 7 | **Trips A/B 31/31 (full lifecycle)** | `MIGRATION-PHASE-7-TRIPS.md` |
| Admin domain policies (RBAC / pagination & clamp / taxi validity / restore & shutdown guards / audit) | `src/domain/admin/adminPolicies.js`, `adminValues.js`, `Admin.js` | 8 | `tests/unit/admin.test.js` (15 cases) | `MIGRATION-PHASE-8-ADMIN.md` |
| Admin frozen REST/JSON contract (28 general endpoints; SQL/analytics/logger/metrics/FS/PRAGMA/process reused via adapters) | `src/presentation/api/admin{Routes,Controller}.js`, `src/infrastructure/repositories/adminRepositoryAdapter.js`, `src/infrastructure/gateways/adminOpsGateways.js` | 8 | **Admin A/B 43/43** | `MIGRATION-PHASE-8-ADMIN.md` |
| Admin ADR-003 (Arabic byte-identical; English additive on taxi/restore/shutdown/user-not-found) | `src/presentation/api/adminController.js` | 8 | Admin A/B `user:get:missing:ar-header` parity | `MIGRATION-PHASE-8-ADMIN.md` |
| Admin ADR-007 (JWT+RBAC on every route; path-traversal + confirm-token guards) | `src/domain/admin/adminPolicies.js` (`restorePolicy`/`shutdownPolicy`/`rbacPolicy`), `adminRoutes.js` (`authenticateAdmin`) | 8 | Admin A/B auth/traversal/confirm scenarios | `MIGRATION-PHASE-8-ADMIN.md` |
| Fleet domain policies (registration / validation / availability / assignment) + VOs | `src/domain/fleet/fleetPolicies.js`, `fleetValues.js`, `Fleet.js` | 9 | `tests/unit/fleet.test.js` (10 cases) | `MIGRATION-PHASE-9-FLEET.md` |
| Fleet frozen REST/JSON contract (3 endpoints extracted from Trips + Admin; `taxis` persistence + read cache reused via adapter) | `src/presentation/api/fleet{Routes,Controller}.js`, `src/infrastructure/repositories/fleetRepositoryAdapter.js` | 9 | **Fleet A/B 14/14** | `MIGRATION-PHASE-9-FLEET.md` |
| Fleet ADR-003 (Arabic byte-identical; English additive on registration validation) | `src/presentation/api/fleetController.js` | 9 | Fleet A/B `add:noname:en` / `add:badcoords:en` parity | `MIGRATION-PHASE-9-FLEET.md` |
| Fleet ADR-007 (admin RBAC on register/remove; sanitized projection prevents column leaks) | `src/presentation/api/fleetRoutes.js` (`authenticateAdmin`), `src/domain/fleet/fleetPolicies.js` (`fleetValidationPolicy`) | 9 | Fleet A/B auth/RBAC/exposure scenarios | `MIGRATION-PHASE-9-FLEET.md` |
| AI/Automation ADR-011 decision architecture (D1–D4 classes, deterministic fallback, safety-not-gated-on-AI, audit) | `src/domain/ai/aiPolicies.js`, `aiValues.js`, `AI.js` | 10 | `tests/unit/ai.test.js` (13 cases) | `MIGRATION-PHASE-10-AI.md` |
| AI existing-automation ownership (matching/fare/rollback classified D3; provider disabled ⇒ fallback, never invoked) | `src/application/ai/*`, `src/infrastructure/ai/aiProviderAdapter.js`, `aiGateways.js` | 10 | **AI zero-drift A/B 16/16** | `MIGRATION-PHASE-10-AI.md` |
| AI ADR-007 (AI never owns governance: D1 non-automatable; audit reused via existing logger; no endpoint added) | `src/domain/ai/aiPolicies.js` (`aiSafetyPolicy`), `src/infrastructure/ai/aiGateways.js` (`aiAuditRepository`) | 10 | `tests/unit/ai.test.js` + zero-drift A/B | `MIGRATION-PHASE-10-AI.md` |
| ADR-001 (Commerce/C-1) ratified — settlement consistency substrate | `src/config/database.js` (serialization mutex), Trips `completionGateway` (idempotent completion) | 11 | C-1 race re-tests (one 200 + one 4xx; one deduction; one `trip_payment` row) | `docs/ADR-001-transaction-concurrency.md` (§0 ratification) |
| Commerce domain policies (settlement / balance / payment-validation / refund / idempotency / ledger-consistency) + VOs | `src/domain/commerce/commercePolicies.js`, `commerceValues.js`, `Commerce.js` | 11 | `tests/unit/commerce.test.js` (15 cases incl. ledger + idempotency) | `MIGRATION-PHASE-11-COMMERCE.md` |
| Commerce frozen REST/JSON contract (4 endpoints; atomic WalletRepository + ledger + PAYMENT_ENABLED gateway reused via adapters) | `src/presentation/api/commerce{Routes,Controller}.js`, `src/infrastructure/repositories/commerceRepositoryAdapter.js`, `src/infrastructure/gateways/commerceGateways.js` | 11 | **Commerce A/B 15/15 (full charge lifecycle)** | `MIGRATION-PHASE-11-COMMERCE.md` |
| Commerce ADR-007 (JWT + IDOR ownership on wallet reads; charge envelope; atomic-deduct integrity; gateway posture) | `src/domain/commerce/commercePolicies.js` (`ownershipPolicy`/`paymentValidationPolicy`/`balancePolicy`), `commerceRoutes.js` | 11 | Commerce A/B auth/IDOR/validation + unit | `MIGRATION-PHASE-11-COMMERCE.md` |
| Socket.IO event contract frozen | `src/socket.js` | legacy | — | G0.0 §2 |
| Domain/integration events | **(gap)** | — | — | ADR-006 (Planned) |

## ADR-007 — Security Architecture
| Requirement | Src | Phase | Test | Report/Proof |
|---|---|---|---|---|
| JWT + refresh rotation + revocation | `src/middleware/auth.js`, `src/infrastructure/gateways/tokenGatewayAdapter.js` | 2 | identity A/B (rotation, replay-401) | MIGRATION-PHASE-2 §6 |
| RBAC (admin) | `authenticateAdmin`, driver-approval endpoints | P6-06 | E2E approval, live security tests | P6-06 report |
| Driver ownership + approval/suspension session revocation | `driversController.js`, `driverPolicies.js`, `driverSessionControlAdapter.js` | 4 | Drivers unit + A/B no-auth/IDOR scenarios | `MIGRATION-PHASE-4-DRIVERS.md` |
| Scooter unlock/lock authorization + atomic anti-race claim + ownership | `src/domain/scooters/scooterPolicies.js`, `scootersController.js` | 5 | Scooters A/B (noauth 401, notyours 403, race 409) | `MIGRATION-PHASE-5-SCOOTERS.md` |
| OTP gate | `src/services/otpService.js`, `otpGatewayAdapter.js` | 2 | replay disproven (live) | Production-Proof audit |
| IDOR prevention (JWT-only identity) | `src/domain/users/userPolicies.js`, `usersController.js` | 3 | Users A/B `balance:idor 403` | verifier R3 |
| Rate limiting | `src/middleware/rateLimiter.js` | legacy | identity A/B (429 parity) | — |
| PII masking in logs | `src/domain/shared/Phone.js` (`maskPhone`) | 2 | — | **partial: rateLimiter logs raw phone (H-1 debt)** |

## ADR-008 — Technical Architecture (project structure)
| Requirement | Src | Phase | Proof |
|---|---|---|---|
| Layered `src/` structure per context | `src/{domain,application,infrastructure,presentation}/<context>/` | 1–3.5 | directory tree + verifier discovery (26 files) |
| Dependency-injection composition roots | `*Routes.js` + `server.js` DI container | 2–3 | verifier R7 |

## ADR-009 — Deployment & Operations
| Requirement | Src | Proof |
|---|---|---|
| Container image | `Dockerfile` (85 lines), `backup/Dockerfile` | present |
| Production topology (app+db+cache+edge) | `docker-compose.prod.yml` (postgres:17, redis:7, nginx) | present; postgres/redis **not yet consumed** |
| TLS edge gateway | `nginx/nginx.conf` | present |
| CI/CD + progressive deploy + rollback | `.github/workflows/{ci,deploy,docker-release,emergency-rollback,quality,release-please}.yml` | present |
| Backup/DR | `docker-compose.backup.yml`, `src/services/backup.js` | present (offsite = gap) |

## ADR-010 — Observability & Reliability
| Requirement | Src | Proof |
|---|---|---|
| Health checks | `src/routes/health.js` (`/health`: db/memory/event-loop) | live 200/503 |
| Metrics | `src/middleware/metrics.js`, `/admin/metrics` | in-process only |
| Monitoring stack | `docker-compose.monitoring.yml` (Prometheus/Grafana) | present |
| Scrapeable metrics (`prom-client`) | **(gap)** | M-5 debt (Planned) |
| Structured logging + rotation | `src/utils/logger.js` | file rotation live |

## ADR-011 — AI & Automation
| Requirement | Src | Proof |
|---|---|---|
| AI/automation context | **(gap)** — none today | ADR-011 Planned; MCP tooling is operator tooling, not this context |

## ADR-012 — Enterprise Governance
| Requirement | Src | Proof |
|---|---|---|
| Executable architecture verification | `architecture/compliance/verify-architecture.mjs` | **PASS, 8 rules, 26 files** |
| Traceability matrix | `architecture/compliance/MATRIX.md` | 11 contexts × 14 ADRs, no undefined cell |
| Compliance documents per ADR | `architecture/compliance/ADR-0xx.md` | 14 docs |
| Rules registry | `architecture/compliance/RULES.md` | 15 rules |

## ADR-013 — Enterprise Evolution Roadmap
| Requirement | Src | Proof |
|---|---|---|
| Phased strangler migration | `architecture/MIGRATION-PHASE-{1,2,3}.md`, this Phase 3.5 | Identity + Users cut over, contracts frozen |

## ADR-014 — Global Platform Reference Architecture
| Requirement | Src | Proof |
|---|---|---|
| Consolidated reference (no new architecture) | traces to ADR-002…013 | this matrix + evidence are the live index |

## ADR-015 — Enterprise Architecture Manifesto
| Requirement | Src | Proof |
|---|---|---|
| Evolve in place, freeze contracts, no stealth changes | every migration under A/B proof; legacy kept as rollback | MIGRATION-PHASE-2/3 §rollback, verifier gate |
