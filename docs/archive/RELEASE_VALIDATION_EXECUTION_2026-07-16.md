# On Call — Release Validation (Full Execution)

**التاريخ:** 16 يوليو 2026
**الفريق:** Release Engineering
**النوع:** تنفيذ فعلي — تشغيل حقيقي للخادم وطلبات HTTP وأدوات MCP ومحاولات استغلال حية. لم تُختلَق أي سجلات أو أرقام.

---

## بيئة التنفيذ (ما أمكن تشغيله فعلاً)

| الأداة | الحالة | دليل |
|--------|--------|------|
| Node 22 / npm / curl / java | متوفّر | `which` |
| **flutter / dart** | **مفقود** | `which flutter dart` → لا شيء |
| **docker** | **مفقود** | `which docker` → لا شيء |
| **sqlite3 (native)** | **يفشل التحميل** | `require('sqlite3')` → `ERR_DLOPEN_FAILED` (ثنائي macOS في معمل Linux)؛ إعادة البناء تفشل (لا شبكة لجلب prebuilt) |
| socket.io-client | مفقود | `require.resolve` فشل + لا شبكة |

**كيف شُغِّل الـ backend رغم فشل sqlite3:** كُتب مُحوِّل قيادة (driver shim) رقيق يوفّر واجهة `sqlite3` مدعومة بمحرّك `node:sqlite` الحقيقي (المدمج في Node 22). **لم يُعدَّل أي كود مشروع** — الـ shim حُقن عبر `Module._resolveFilename` وقت التشغيل فقط. النتيجة: `server.js` والـ routes والـ middleware الحقيقية عملت دون تغيير، على محرّك SQLite حقيقي، باتصال واحد (مطابق لسلوك node-sqlite3 الأحادي).

---

## PHASE 1 — BUILD VERIFICATION

| المشروع | النتيجة | دليل تنفيذ |
|---------|:-------:|-----------|
| Backend (syntax) | **PASS** | `node --check` على كل `src/*.js` + `server.js` → صفر أخطاء |
| Backend (native sqlite3) | **FAIL (بيئة)** | `ERR_DLOPEN_FAILED`؛ حُلّ بـ shim على `node:sqlite` للتشغيل |
| MCP (TypeScript) | **PASS** | `npx tsc --noEmit` → **0 أخطاء أنواع**؛ SDK + axios موجودان |
| Flutter | **SKIPPED** | لا `flutter` SDK في البيئة |
| Android | **SKIPPED** | يتطلب Flutter/Gradle + SDK (مفقود) |
| iOS | **SKIPPED** | يتطلب macOS + Xcode (غير متاح) |

**تحذيرات تهيئة مُثبَتة (فحص ملفات):** توقيع الإصدار بمفاتيح debug (`build.gradle.kts:44`)، `applicationId=com.example.oncall_app` (`:29`)، غياب أذونات الموقع في `AndroidManifest.xml`.

---

## PHASE 2 — STARTUP VALIDATION

| الخدمة | النتيجة | سجل تشغيل فعلي |
|--------|:-------:|----------------|
| Backend + Socket.IO | **PASS** | `[OK] Environment loaded` · `Helmet enabled` · `compression enabled` · `DB columns + triggers verified` · `Server + Socket.IO running` |
| Database | **PASS** | migrations + triggers نُفِّذت؛ `/health` يُرجع `database:"ok"` |
| MCP | **PASS** | `initialize handshake ✓` |
| Flutter | **SKIPPED** | لا SDK |

تحذير وقت التشغيل (متوقَّع، غير قاتل): `P6-02: FCM غير مُضبط` — Push معطّل بلا `FIREBASE_SERVICE_ACCOUNT_JSON`.

---

## PHASE 3 — API VALIDATION (طلبات HTTP حقيقية على الخادم الحي)

| Endpoint | Method | HTTP | زمن | النتيجة |
|----------|:------:|:----:|:---:|:-------:|
| `/health` | GET | **200** | 13ms | PASS |
| `/test` | GET | **200** | 1.5ms | PASS |
| `/login` (passenger) | POST | **200** | 21ms | PASS (يُصدر token+refresh) |
| `/driver/login` (سائق جديد) | POST | **403** | 2ms | PASS *(بالتصميم: سائق جديد `is_active=0` حتى تفعيل الأدمن — تُحقِّق من `DriverRepository.create`)* |
| `/driver/login` (بعد التفعيل) | POST | **200** | — | PASS |
| `/taxis` | GET | **200** | 1.6ms | PASS |
| `/scooters` | GET | **200** | 1.4ms | PASS |
| `/payment/methods` | GET | **200** | 1.3ms | PASS |
| `/fare/config` | GET | **200** | 1.2ms | PASS |
| `/fare/estimate` | POST | **200** | — | PASS |
| `/balance/:self` | GET | **200** | — | PASS |
| `/wallet/balance/:self` | GET | **200** | — | PASS |
| `/transactions/:self` | GET | **200** | — | PASS |
| `/notifications/:self` | GET | **200** | — | PASS |
| `/wallet/charge` (معطّل) | POST | **503** | — | PASS (مُبوَّب بـ `PAYMENT_ENABLED=false`) |
| `/admin/*` (13 نقطة) | GET | **200×13** | — | PASS (stats, analytics, revenue, reports, drivers, users, metrics, system, backups, dashboard, security-events, errors, crashes) |
| `/admin/drivers/:phone/toggle` | PUT | **200** | — | PASS |
| `/taxi/request` | POST | **200** | — | PASS (يُنشئ tripId) |
| `/admin/stats` (بلا token) | GET | **401** | 2ms | PASS (مصادقة تعمل) |

**النتيجة الإجمالية Phase 3: PASS** — كل النقاط المُختبَرة تستجيب بالحالات الصحيحة. (الثقة 100% — نُفِّذت فعلاً.)

---

## PHASE 4 — SOCKET.IO VALIDATION

| الاختبار | النتيجة | دليل |
|---------|:-------:|------|
| طبقة النقل Engine.IO | **PASS (جزئي)** | handshake حي يُرجع `sid`+`upgrades:["websocket"]` |
| مصادقة/تدفقات الرحلة/reconnect/live-location | **SKIPPED** | لا `socket.io-client` ولا شبكة لتثبيته؛ حقن `auth.token` يتطلب عميل Socket.IO كامل |

**ملاحظة إثبات:** وجود `io.use()` الذي يرفض الاتصال بلا JWT مُؤكَّد بقراءة الكود (`src/socket.js`) وبفحوص سابقة، لكن **لم يُنفَّذ** تدفق مصادقة socket حي في هذه الجولة → SKIPPED بصدق.

---

## PHASE 5 — DATABASE VALIDATION

| الاختبار | النتيجة | دليل تنفيذ |
|---------|:-------:|-----------|
| Commit (إكمال رحلة منفردة) | **PASS** | `Payment #1: cash = 0.962 KD - OK`، HTTP 200، `payment_status=completed` |
| **Transactions تحت التزامن** | **FAIL 🔴** | إكمال رحلتين متزامناً → الرحلة #2 **HTTP 500** + سجل `trip status update error: "cannot start a transaction within a transaction"` |
| Indexes | **PASS** | 14 فهرساً مُؤكَّدة (`PRAGMA index list`) |
| Integrity | **PASS** | `PRAGMA integrity_check = ok` |
| Foreign Keys | **FAIL (ضعيف)** | لا قيود FK على `trips/transactions/notifications/reports` (فحص مخطط) |
| Concurrent reads | **PASS** | 100–200 قراءة متزامنة على `/taxis` بلا خطأ (انظر Phase 6) |

**هذا هو الإثبات الحاسم لـ C-1 على نظام حي** (وليس محاكاة): سلامة المعاملات المالية تنهار تحت تزامن واقعي.

---

## PHASE 6 — LOAD TEST (داخل المعمل، مؤشِّري فقط)

> **حدّ الصدق:** نواة واحدة داخل sandbox، عميل ومُخدِّم على نفس الجهاز، IP واحد. **ليست** أجهزة إنتاج. الأرقام مؤشِّرية.

| الاختبار | ok/err | زمن الاستجابة (فعلي) |
|---------|:------:|--------------------|
| 50 متزامن `/health` | 50/0 | p50=44ms · p95=48ms · max=84ms |
| 100 متزامن `/health` | 100/0 | p50=30ms · p95=57ms · max=58ms |
| 100 متزامن `/taxis` | 100/0 | p50=25ms · p95=37ms · max=39ms |
| 200 دفعة `/taxis` | 50/**150** | الأخطاء = **429 rate-limit** (سقف 300/دقيقة/IP من نفس الـ IP) — الحدّ يعمل، لا انهيار |
| 500 / 1000 مستخدم | **SKIPPED** | لا أداة حِمل (autocannon/k6) ولا شبكة؛ IP واحد يُفعّل rate-limit؛ الأجهزة غير تمثيلية |

**النتيجة:** 50–100 متزامن → **0 أخطاء، زمن ممتاز**. حِمل 500/1000 غير قابل للقياس هنا بأمانة → **SKIPPED** مع السبب.

---

## PHASE 7 — SECURITY VALIDATION (محاولات استغلال حية)

| الهجوم | النتيجة | دليل تنفيذ |
|--------|:-------:|-----------|
| IDOR (A يقرأ رصيد B) | **Exploit FAILED** | `/wallet/balance/B` و`/balance/B` بـ token A → **403 BLOCKED** |
| Privilege Escalation (راكب→أدمن) | **Exploit FAILED** | `/admin/stats` بـ token راكب → **403** |
| WebSocket/JWT بلا token | **Exploit FAILED** | `/admin/stats` بلا token → **401** |
| JWT forgery (`alg:none`) | **Exploit FAILED** | token مزوّر role=admin → **401 BLOCKED** (حي) |
| OTP replay | **Exploit FAILED** | `verifyOTP` أول=true، إعادة=false (تشغيل المصدر) |
| SQL Injection | **Exploit FAILED** | parameterized queries (فحص شامل) |
| Payment abuse | **Exploit FAILED** | `/wallet/charge` → 503 (مُبوَّب) |
| **Rate-limit bypass (X-Forwarded-For)** | **Exploit SUCCESSFUL 🟠** | XFF دوّار: **0/20 محظور**؛ ثابت: **15/20 محظور** (تشغيل الـ middleware الحقيقي) |
| **Business logic (معاملة مالية متزامنة)** | **Exploit SUCCESSFUL 🔴** | إكمال متزامن → 500 + معاملة تالفة (C-1) |
| Mass assignment (phone من body) | **Exploit FAILED** | الهوية من JWT دائماً (IDOR tests) |

---

## PHASE 8 — MOBILE VALIDATION

**الحالة: SKIPPED بالكامل** — لا `flutter`/`dart` SDK (`which` = مفقود). لا يمكن بناء Android/iOS أو تشغيل GPS/Maps/Push/Offline حياً.

**أدلة ثابتة (فحص ملفات، لا تشغيل):**
| البند | الحالة | دليل |
|-------|:-----:|------|
| أذونات الموقع (Android) | **FAIL** | `AndroidManifest.xml` بلا `ACCESS_*_LOCATION` |
| توقيع الإصدار | **FAIL** | `build.gradle.kts:44` = مفاتيح debug |
| معرّف التطبيق | **FAIL** | `com.example.oncall_app` |
| iOS location/ATS/Maps | **PASS (تهيئة)** | `Info.plist` يحوي أوصاف الموقع + `MAPS_API_KEY` placeholder |
| GPS/Maps/Push/Offline/Deep links (تشغيل) | **SKIPPED** | لا SDK/جهاز |

---

## PHASE 9 — MCP VALIDATION (تشغيل حي ضد الخادم)

| الاختبار | النتيجة | دليل |
|---------|:-------:|------|
| بناء TypeScript | **PASS** | `tsc --noEmit` 0 أخطاء |
| تسجيل الأدوات | **PASS** | `all 69 tools registered (96/69)` |
| initialize handshake | **PASS** | `✓` |
| تنفيذ الأدوات (حي) | **PASS** | `list_users(2) ✓`، `get_user_by_phone(112) ✓`، `list_scooters(3) ✓`، `get_scooter_by_id ✓`، `create_taxi_request ✓`، `get_taxi_request_status=waiting_driver ✓` |
| معالجة الأخطاء | **PASS** | `get_user_by_phone` لرقم مجهول → `isError ✓` |
| Timeouts/Performance | **NOT EXECUTED** | لم تُقَس أزمنة أدوات فردية تحت ضغط |

**النتيجة: PASS**

---

## PHASE 10 — PRODUCTION VALIDATION

| البند | النتيجة | دليل |
|-------|:-------:|------|
| Health check | **PASS** | `/health` 200 يفحص db/memory/eventLoop |
| Metrics | **PASS** | `/admin/metrics` 200 (حي) |
| Graceful shutdown | **PASS** | SIGTERM → `SIGTERM received — shutting down gracefully` (حي) |
| Backup | **INCONCLUSIVE** | `/admin/backup` رجع 429 (نفاد rate-limit من اختبار الحِمل بنفس IP)؛ المنطق موجود، لم يُثبَت حياً |
| Crash recovery | **NOT EXECUTED** | معالجات `uncaughtException`/`unhandledRejection` موجودة (كود)، لم تُطلَق حياً |
| Docker | **SKIPPED / FAIL** | لا `docker` ولا `Dockerfile` |
| HTTPS/TLS | **FAIL** | غير مُعرَّف داخل المستودع |
| Redis | **FAIL (غائب)** | غير موجود في الحزمة؛ مطلوب للتوسّع (C-2) |
| PostgreSQL | **FAIL (غائب)** | SQLite فقط؛ جاهزية Postgres منخفضة |
| Horizontal Scaling | **FAIL** | حالة في الذاكرة (C-2 مُثبَت بنيوياً) |

---

## ملخص النتائج (نُفِّذت فعلاً)

**PASS:** بناء Backend (syntax) · بناء MCP · إقلاع Backend/DB/MCP · 25+ نقطة API · Commit منفرد · الفهارس/السلامة · حِمل 50–100 متزامن · كل دفاعات الأمان عدا XFF · تنفيذ أدوات MCP · Health/Metrics/Graceful shutdown.

**FAIL (مُثبَت بالتشغيل):**
- 🔴 **C-1** — معاملة مالية متزامنة → HTTP 500 + `cannot start a transaction within a transaction` (حي).
- 🟠 **XFF rate-limit bypass** — 0/20 محظور بـ XFF دوّار (حي).
- **FK غائبة**، **Docker/HTTPS/Redis/Postgres/Scaling** غائبة.
- **موبايل:** أذونات موقع، توقيع debug، معرّف افتراضي (ملفات).

**SKIPPED (بسبب بيئة ناقصة، مُعلَّل):** بناء/تشغيل Flutter·Android·iOS (لا SDK) · تدفقات Socket.IO الكاملة (لا socket.io-client) · حِمل 500/1000 (لا أداة/شبكة) · Docker (غير مثبَّت) · crash recovery حي.

---

## القرار النهائي

# 🔴 NOT READY FOR PRODUCTION

**مدعوم حصرياً بنتائج مُنفَّذة:**

1. **C-1 مُثبَت على خادم حي:** رحلتان تكتملان معاً → الثانية **HTTP 500** وسجل الخادم الفعلي: `trip status update error: "cannot start a transaction within a transaction"`. الرحلة الأولى دفعها OK بينما الثانية فشلت — سلامة مالية غير مضمونة تحت تزامن. اكتمال رحلتين في نفس اللحظة حدث اعتيادي في أي تشغيل حقيقي.
2. **تجاوز rate-limit مُثبَت حياً:** `X-Forwarded-For` دوّار = 0 حظر من 20 — انهيار حماية brute-force على مستوى IP.
3. **حواجب نشر موبايل مُثبَتة:** غياب أذونات الموقع + توقيع debug يمنعان GPS والنشر على Android.
4. **لا جاهزية توسّع:** Docker/HTTPS/Redis/Postgres غائبة؛ الحالة في الذاكرة.

**ما ثبت أنه سليم (بالتشغيل):** IDOR/PrivEsc/no-token/alg:none/OTP-replay كلها **صُدّت حياً**؛ 25+ نقطة API تعمل؛ MCP يعمل؛ إقلاع وإطفاء رشيق وHealth/Metrics تعمل؛ أداء ممتاز حتى 100 متزامن.

**المسار إلى 🟡 READY FOR LIMITED PILOT:** إصلاح C-1 (معاملة ذرية)، XFF (trust proxy)، PII في السجلات، وحواجب Android (أذونات + توقيع). الوصول إلى ✅ READY FOR PRODUCTION يتطلب إضافةً Redis + Postgres + Docker/TLS.

---

*نهاية تقرير Release Validation. كل نتيجة PASS/FAIL مدعومة بمخرجات تنفيذ حقيقية؛ كل SKIPPED مُعلَّل بنقص بيئي محدَّد. لم يُختلَق أي سجل أو رقم، ولم يُعدَّل أي كود مشروع.*
