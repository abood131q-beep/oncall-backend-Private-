# On Call — التدقيق الشامل للمستودع بالكامل (100% Repository-Wide Audit)

**التاريخ:** 16 يوليو 2026
**الأدوار:** Principal Engineer · Chief Architect · Security Engineer · Production Readiness Auditor
**النوع:** قراءة فقط — لم يُعدَّل أي كود
**النطاق:** `oncall-backend` (Express/Node) · `oncall_app` (Flutter) · `oncall-mcp` (TypeScript، داخل `tools/`)

> **منهجية الإثبات:** كل ادعاء مُتحقَّق منه بقراءة الكود أو بأمر تحقّق فعلي (grep/find/npm audit/فحص المخطط). البنود بلا دليل قاطع مُعلَّمة **NOT VERIFIED**. البنود التي بدت مشاكل وثبت أنها سليمة مُدرَجة في قسم **False Positives**.

---

## 1. الملخص التنفيذي

جرى تدقيق المستودع بالكامل عبر المشاريع الثلاثة، بما فيها الملفات المخفية والتهيئة ومنصّات android/ios. النتيجة تؤكد وتُوسِّع تدقيق المرحلة السابقة، وتكشف **مشاكل جديدة في طبقة الموبايل والـ MCP لم تظهر في التدقيق الأول**.

الهندسة البرمجية للـ backend ناضجة: فصل طبقات نظيف (routes/services/repositories)، DI يدوي متسق، معالجة أخطاء شاملة، graceful shutdown، وصفر ثغرات في `npm audit` عبر المشروعين. لكن ثلاث فئات من المخاطر تحجب الإنتاج:

1. **معماري:** كل الحالة الحرجة في ذاكرة العملية (كاش، rate-limit، مؤقتات، sockets) → استحالة التوسّع الأفقي، وخطأ تزامن مالي حقيقي على اتصال SQLite واحد.
2. **جاهزية الموبايل:** **غياب أذونات الموقع في Android manifest** (تطبيق نقل بلا GPS على أندرويد)، وتوقيع الإصدار بمفاتيح debug، ومعرّف تطبيق `com.example` الافتراضي — ثلاثتها تحجب النشر على المتاجر.
3. **تعريض MCP:** رمز أدمن (admin JWT) يُخزَّن في `/tmp` بصلاحيات افتراضية، وأدوات تشغيل خادم عن بُعد بلا مصادقة على مستوى الأداة.

**الحُكم:** **Needs Improvements** — إطلاق تجريبي single-server ممكن بعد إصلاحات عاجلة؛ الإنتاج الواسع يتطلب 6–9 أسابيع.

---

## 2. إحصائيات المستودع (Repository Statistics)

> مُقاسة فعلياً عبر `find`/`wc` (باستثناء `node_modules`, `.git`, `build`, `.dart_tool`, `dist`).

| المقياس | القيمة |
|---------|--------|
| **المشاريع** | 3 (backend، Flutter app، MCP server) |
| **مجلدات backend** (excl vendored) | 32 |
| **ملفات backend** (excl vendored) | 170 |
| **مجلدات Flutter** (excl vendored) | 336 |
| **ملفات Flutter** (excl vendored) | 1,036 |
| **مجلدات MCP** | 7 |
| **ملفات MCP** | 73 |

### أسطر الكود (LOC) للمصدر الفعلي

| اللغة/الطبقة | ملفات | LOC |
|--------------|:-----:|:---:|
| Backend JS (`src/` + `server.js` + `database.js`) | 36 | **7,523** |
| Flutter Dart (`lib/`) | 30 | **8,884** |
| MCP TypeScript (`src/`) | 15 | **3,057** |
| Flutter tests (`test/`) | 1 | 30 |
| **إجمالي كود المصدر** | **~82** | **≈ 19,494** |

### اللغات المكتشفة
JavaScript (Node/Express)، TypeScript (MCP)، Dart (Flutter)، SQL (داخل JS)، YAML (CI/pubspec)، Kotlin/Gradle (Android)، Swift/plist (iOS)، Bash (scripts).

### أكبر الملفات (مصدر)

| الملف | أسطر |
|-------|:----:|
| `lib/admin_dashboard.dart` | 1,252 |
| `src/routes/admin.js` | 865 |
| `lib/map_page.dart` | 743 |
| `src/routes/taxi.js` | 694 |
| `lib/driver_page.dart` | 684 |
| `lib/driver_profile_page.dart` | 648 |
| `lib/analytics_page.dart` | 587 |
| `lib/scooter_page.dart` | 550 |
| `lib/wallet_page.dart` | 538 |
| `src/repositories/TripRepository.js` | 352 |

### أكبر المجلدات (منطقياً)
`oncall_app/lib` (8.9K LOC)، `oncall-backend/src` (7.5K LOC)، `oncall-mcp/src` (3K LOC)، `docs/` (7 ملفات + مجلدات فرعية)، `backups/` (نسخ .db محلية).

---

## 3. مراجعة البنية المعمارية (Architecture Review)

**نقاط القوة:** نمط طبقي واضح — Routes (HTTP) → Services (منطق أعمال) → Repositories (وصول بيانات) → Database wrappers. DI عبر كائن `services` واحد يُمرَّر لكل router (factory pattern: `module.exports = function createXRouter(svc)`). فصل مسؤوليات جيد في الأغلب.

**المخالفات المُثبَتة:**
- **اقتران جذري:** `src/config/database.js` يستورد `../../database.js` (ملف الجذر) الذي يخلط تعريف المخطط + بيانات البذور (seed) + الفهارس + اتصال sqlite3 في مكان واحد خارج طبقة `src/`. مخالفة طبقية.
- **God Routers:** `admin.js` (865 سطر) يجمع stats + trips + users + backups + system + db-ops + shutdown + metrics + security-events في ملف واحد.
- **DI في `server.js`:** كائن `services` يدوي بـ ~50 مفتاحاً — نما `server.js` إلى 255 سطراً (الهدف كان ~70).
- **ازدواجية في Flutter:** ملفات `lib/*.dart` قديمة (`session_service.dart`, `socket_service.dart`, `places_service.dart`, `fcm_service.dart`, `notification_service.dart`) هي مجرد `export` stubs تعيد التصدير من `lib/services/`. طبقتان لنفس الشيء.

**Circular dependencies:** لا دورات مُثبَتة. `env.js` يكتب `LOG_LEVEL` في `process.env` بدل استيراد `logger` (تجنّب مقصود للدورة — تصميم سليم).

---

## 4. مراجعة الـ Backend

المسارات مُصادَق عليها بشكل منهجي: كل endpoint حساس يستخدم `authenticate`/`authenticateDriver`/`authenticatePassenger`/`authenticateAdmin`. الهوية تُشتَق **دائماً** من `req.user.phone` (JWT) لا من body/params — دفاع IDOR متسق ومُثبَت عبر كل `src/routes/*.js`.

**إيجابيات مُثبَتة:** فحوص ملكية على كل انتقال حالة رحلة، قبول ذري (`acceptByDriver` مع `WHERE status='waiting_driver'`)، خصم رصيد ذري (`deductBalanceSafe`)، فتح سكوتر ذري (`setRiding` مع `WHERE status='available'`)، pagination بحد أقصى 100 لمنع DoS، وn+1 مُتجنَّب في `driver/stats` عبر تجميع SQL.

**مشاكل:** تُفصَّل في الأقسام 16–19 (خطأ المعاملات C-1، التنظيف المُتلِف M-1، God routers).

---

## 5. مراجعة Flutter

**البنية:** `SessionService` static يدير token/refresh مع حفظ على `SharedPreferences` واستعادة عند الإقلاع، وتجديد تلقائي عبر `/auth/refresh`. `SocketService` يدير الاتصال مع `onDisconnect`/`onReconnect` وإلغاء المستمعين (`socket.off(...)`) — إدارة موارد جيدة نسبياً.

**مشاكل مُثبَتة (جديدة في هذا التدقيق):**
- 🟠 **غياب أذونات الموقع في Android manifest:** `android/app/src/main/AndroidManifest.xml` يحوي فقط `POST_NOTIFICATIONS` و`c2dm.RECEIVE`. **لا** `ACCESS_FINE_LOCATION` ولا `ACCESS_COARSE_LOCATION` رغم استخدام `geolocator` و`google_maps_flutter`. إضافة geolocator لا تحقن هذه الأذونات — يجب أن يعلنها التطبيق. النتيجة: تحديد الموقع يفشل على أندرويد في الإصدار الفعلي.
- 🟠 **توقيع الإصدار بمفاتيح debug:** `android/app/build.gradle.kts` — `release { signingConfig = signingConfigs.getByName("debug") }` مع تعليق `TODO`. يمنع النشر على Google Play ويُضعف الأمان.
- 🟡 **معرّف التطبيق الافتراضي:** `applicationId = "com.example.oncall_app"` — placeholder افتراضي يمنع النشر على المتاجر.
- 🟡 **تغطية اختبار شبه معدومة:** ملف اختبار واحد (`test/widget_test.dart`، 30 سطراً، القالب الافتراضي). لا اختبارات لـ SessionService أو socket handlers أو تدفق الرحلة.
- 🟢 **الافتراضي `http://172.20.10.2:3000`** في `lib/config.dart` (IP hotspot). يُستخدم `--dart-define=BASE_URL` (جيد) لكن الافتراضي غير صالح للإنتاج وبلا HTTPS.
- 🟢 **ازدواج stubs** (القسم 3).

**إيجابيات:** iOS مُهيَّأ جيداً — `Info.plist` يحوي أوصاف أذونات الموقع الثلاثة و`MAPS_API_KEY` عبر placeholder `$(MAPS_API_KEY)`. مفاتيح Maps تُقرأ من `local.properties`/`Info.plist` placeholders لا من الكود (مُثبَت: لا `AIza` في `android/` أو `ios/`).

**Null safety / State management:** SDK `^3.12.1` (null-safe). إدارة الحالة عبر `setState` + خدمات static (لا حقن تبعيات رسمي). مقبول للحجم الحالي لكن static singletons تصعّب الاختبار.

---

## 6. مراجعة قاعدة البيانات

**المخطط:** 13 جدولاً في `database.js` + 3 جداول migration (`revoked_tokens`, `otp_codes`, `rate_limit_locks`) في `src/config/migrate.js`. Migrations آمنة للتكرار (تتجاهل `duplicate column`)، وTriggers لـ `updated_at`.

**الفهارس:** 14 فهرساً مُثبَتة على القرص (`idx_trips_*`, `idx_drivers_*`, `idx_users_phone`, `idx_transactions_phone`, `idx_rt_hash`, ...). تغطية جيدة للاستعلامات الشائعة.

**سلامة البيانات (مُثبَتة عبر فحص المخطط الفعلي):**
- `PRAGMA integrity_check` = **ok**؛ `PRAGMA foreign_key_check` = **لا انتهاكات**.
- 🟡 **غياب قيود FK:** `trips` (لا FK على `user_id`/`driver_id`)، `transactions` (لا FK على `trip_id`/`phone`)، `notifications`, `reports`. رغم `PRAGMA foreign_keys=ON` فالجداول بلا قيود → بيانات يتيمة ممكنة.
- 🟢 **جدول `wallets` ميت:** مُنشأ لكن لا استعلام واحد يمسّه (مُثبَت: صفر `FROM/INTO/UPDATE wallets` في `src/`). الرصيد فعلياً في `users.balance`.

**جاهزية PostgreSQL:** منخفضة. الكود يعتمد سلوكيات SQLite: `datetime('now',...)`, `strftime`, `INSERT OR IGNORE`/`ON CONFLICT`, و`this.lastID`/`this.changes` من sqlite3. الترحيل يتطلب طبقة تجريد أو إعادة كتابة الاستعلامات.

**اتصال واحد:** `new sqlite3.Database(DB_PATH)` — اتصال وحيد مشترك. SQLite كاتب واحد؛ يحدّ الإنتاجية ويسبّب C-1 (معاملات متداخلة).

---

## 7. مراجعة Socket.IO

**المصادقة:** `io.use()` يرفض أي اتصال بلا JWT صالح؛ `socket.data.user` مصدر الهوية الوحيد. Rate limiting لكل socket على `driver:location` (120/دقيقة). فحص ملكية الرحلة قبل بثّ الموقع. تنظيف الغرف عند `disconnect` وضبط السائق offline.

**مشاكل مُثبَتة:**
- 🟠 **مصادقة عند الـ handshake فقط:** لا إعادة تحقق دورية؛ token مُبطَل/منتهٍ يظل صالحاً طوال عمر الاتصال (القسم 17، H-3).
- 🟠 **غرف في الذاكرة بلا Redis adapter:** يكسر التشغيل متعدد النسخ (القسم 16، C-2).
- 🟢 **`setInterval` إصلاح التاكسيات كل ساعة** — `.unref()` مضبوط (لا يمنع الخروج). سليم.

---

## 8. مراجعة الأمان (OWASP + منطق الأعمال)

| فئة OWASP | الحالة | الدليل |
|-----------|--------|--------|
| A01 Broken Access Control | ✅ قوي | IDOR مُعالَج عبر JWT-only identity في كل route |
| A02 Cryptographic Failures | ⚠️ | JWT HS256 يدوي سليم (timingSafeEqual، محصَّن ضد alg:none)؛ لكن لا TLS مُعرَّف |
| A03 Injection | ✅ | parameterized queries في كل مكان (مُثبَت) |
| A04 Insecure Design | ⚠️ | تصميم single-instance؛ رمز MCP في /tmp |
| A05 Security Misconfiguration | ⚠️ | توقيع debug، CORS `*` على socket، trust proxy غير مضبوط |
| A07 Auth Failures | ✅ | OTP hash-only + قفل هاتف مُخزَّن + refresh rotation |
| A09 Logging Failures | 🟠 | **أرقام هواتف كاملة في سجلات rate-limiter** (PII) |

**مشاكل أمنية جديدة (MCP):**
- 🟠 **رمز أدمن في `/tmp`:** `src/token-manager.ts` يكتب admin JWT إلى `os.tmpdir()/oncall-mcp-token.json` بصلاحيات افتراضية (0644). على نظام متعدد المستخدمين، أي مستخدم يقرأ الرمز = صلاحيات أدمن كاملة.
- 🟡 **دخول MCP بالأدمن يتعارض مع `REQUIRE_OTP=true`:** `token-manager` يُسجّل الدخول بـ `phone` فقط، لكن `auth.js` يفحص OTP **قبل** فحص الأدمن. في الإنتاج بـ `REQUIRE_OTP=true` سيفشل دخول MCP بـ 400. **NOT VERIFIED** هل يُشغَّل MCP في الإنتاج.
- 🟡 **أدوات تشغيل خطرة:** `start_server`/`restart_server` تنفّذ `childProcess.spawn("node", ["server.js"])`؛ `/admin/shutdown` يُنهي العملية. المصادقة على مستوى الـ backend (`authenticateAdmin`) موجودة، لكن أي عميل MCP بالرمز المُخزَّن يملك تحكماً كاملاً بدورة حياة الخادم.

**تسريب أسرار:** `.env` **غير** مُتتبَّع في git (مُثبَت: `git check-ignore .env` ينجح، ولا وجود له في تاريخ git). مفاتيح Maps/JWT الحقيقية على القرص فقط. `.env.example` يحوي placeholders آمنة. لا أسرار مُرمَّزة في المصدر (مُثبَت: لا `AIza`/`sk_live` في `src`/`lib`/`tools/src`).

---

## 9. مراجعة الأداء

**إيجابيات:** كاش in-memory بـ TTL للـ taxis/scooters/stats/trips؛ تجميع SQL بدل تحميل صفوف (driver stats, analytics)؛ compression (gzip) مُفعَّل؛ حدّ payload 1MB؛ metrics middleware يتتبّع latency + per-route.

**اختناقات مُثبَتة:**
- 🟡 **`broadcast()` بلا throttling:** `src/services/notificationService.js` يُطلق `Promise.allSettled` على **كل** الهواتف دفعة واحدة، وكل واحد يستعلم DB + يرسل FCM فردياً (لا multicast). بثّ لآلاف المستخدمين = آلاف الطلبات المتزامنة → استنزاف موارد.
- 🟡 **`findNearestDriver` O(n):** يحمّل كل السائقين online ثم يفرز بالمسافة في JS. لا bounding-box ولا فهرسة مكانية. مقبول عند حجم صغير.
- 🟢 **اتصال SQLite واحد** يسقف الإنتاجية (كاتب واحد).

---

## 10. مراجعة DevOps / CI-CD

**CI (`.github/workflows/ci.yml`):** ناضج — 6 jobs: Security Audit (`npm audit --audit-level=high` للـ backend + MCP)، Lint+Format، Build+Syntax، Backend Tests (55 اختبار)، MCP Tests، Summary. `concurrency` cancel-in-progress مضبوط. **مُثبَت: `npm audit` = 0 ثغرات في backend وMCP.**

**نواقص:**
- 🟠 **لا Dockerfile ولا docker-compose** (مُثبَت: غير موجودة). النشر غير قابل للتكرار.
- 🟡 **لا اختبارات Flutter في CI** (لا يوجد job لـ `flutter test`/`flutter analyze`).
- 🟢 **مجلد `scripts/` فارغ** (dead).
- 🟢 **فوضى الجذر:** 5 تقارير `.md` + ملفات `.mjs`/`.txt`/`.command` اختبار في الجذر تُشوّش المستودع.

---

## 11. مراجعة البنية التحتية (Infrastructure)

- **لا Kubernetes/cloud manifests** (مُتوقَّع لهذا الحجم). **NOT VERIFIED** وجود بنية نشر خارجية.
- **Firebase:** اختياري بأمان — التطبيق يعمل بدونه (FCM معطّل فقط)؛ الخادم يقرأ `FIREBASE_SERVICE_ACCOUNT_JSON` (raw أو base64) مع تحذير غير قاتل عند غيابه.
- **النسخ الاحتياطي:** `backup.js` — WAL checkpoint + نسخ + الاحتفاظ بـ 7 نسخ، كل 6 ساعات + عند الإقلاع. 🟢 محلي على نفس القرص فقط — لا نسخة خارجية (لا استرداد من كارثة القرص).
- **ملفات `.fuse_hidden*`** في جذر backend = **False Positive** (بقايا FUSE mount لملفات محذوفة-مفتوحة، ليست ملفات مشروع).

---

## 12. مراجعة جاهزية الإنتاج

| العنصر | الحالة |
|--------|--------|
| Health checks | ✅ `/health` يفحص DB + heap + event-loop lag ويعيد 503 عند التدهور |
| Graceful shutdown | ✅ SIGTERM/SIGINT → إغلاق socket ثم HTTP بمهلة 10s |
| Crash reporting | ✅ `uncaughtException` (exit) + `unhandledRejection` (log) |
| Logging | ✅ file rotation + مستويات + security events — 🟠 لكن PII مكشوف |
| Metrics/Monitoring | ✅ `/admin/metrics` + `/admin/security-events` + CPU/latency |
| Rate limiting | ✅ IP + phone-lock مُخزَّن — 🟠 قابل للتجاوز بـ XFF |
| Backup/Restore | ✅ منطق كامل — 🟢 محلي فقط |
| TLS/HTTPS | ❌ غير مُعرَّف داخل المشروع |
| Docker/Containerization | ❌ غائب |
| Horizontal scaling | ❌ محجوب بالحالة في الذاكرة |

---

## 13. الدَّين التقني

الدَّين **معماري أساساً**: أساس single-instance (كاش/rate-limit/timers/sockets في الذاكرة)، SQLite ملف/اتصال واحد بلا FK، ومعاملات هشّة. دَين ثانوي: God routers (admin 865، taxi 694)، ملفات Flutter عملاقة (admin_dashboard 1252)، كود ميت (`wallets`, `database.js` جذري، Flutter stubs، `scripts/` فارغ)، وعدم اتساق (تقنيع الهاتف في OTP لا في rate-limiter). جاهزية موبايل ناقصة (أذونات، توقيع، معرّف).

---

## 14. جودة الكود

**عالية عموماً:** ESLint 0 أخطاء، Prettier مُطبَّق، توثيق JSDoc عربي غزير ودقيق، تسمية متسقة (`createXRepository`, `authenticateX`)، معالجة أخطاء شاملة مع requestId tracing. **مُثبَت:** كل ملفات `src/` تجتاز `node --check`. نقاط الضعف: حجم الوحدات، وتنظيف input عدواني (`sanitize`).

---

## 15. تغطية الاختبارات

- **Backend:** 55 اختبار وحدة (`tests/unit/repositories.test.js`) — كلها تنجح (مُثبَت محلياً)، + `run_tests.sh` (integration) + MCP tests في CI. تركيز جيد على repositories.
- **Flutter:** ~صفر فعلي (ملف قالب واحد 30 سطر). **فجوة كبيرة** — منطق الحالة الحرج real-time غير مُختبَر.
- **MCP:** `test-mcp.mjs` + `test-mcp-full.mjs` يفحصان تسجيل الأدوات مقابل خادم حيّ.

---

## 16. النتائج الحرجة (🔴 CRITICAL)

**C-1 — خطأ تزامن مالي: `BEGIN TRANSACTION` على اتصال SQLite مشترك**
`src/routes/taxi.js:~327`, `src/routes/scooters.js:~145`. اتصال sqlite3 واحد؛ إنهاء رحلتين متزامناً يُصدر `BEGIN` متداخلاً → فشل أو خلط معاملتين. كما أن `completeTrip()` يُنفَّذ قبل `BEGIN` فالفشل يترك حالة دفع غير متسقة. **الأثر:** خسارة/ازدواج أموال. **الإصلاح:** معاملة ذرية واحدة تشمل الإكمال+الدفع+تحديث الحالة، أو اتصال لكل معاملة، أو Postgres.

**C-2 — استحالة التوسّع الأفقي: كل الحالة في الذاكرة**
`cache.js`, `rateLimiter.js`, `server.js` (tripTimers), `driverMatcher.js` (setTimeout), `socket.js` (لا Redis adapter). **الأثر:** نسختان خلف load balancer يكسران الأحداث real-time وrate-limit. **الإصلاح:** Redis (`@socket.io/redis-adapter` + كاش/rate-limit) + BullMQ للمؤقتات.

---

## 17. النتائج العالية (🟠 HIGH)

- **H-1 — PII في السجلات:** `rateLimiter.js` يسجّل `phone` كاملاً غير مُقنَّع. الإصلاح: `maskPhone()`.
- **H-2 — تجاوز rate-limit عبر `X-Forwarded-For`:** `rateLimiter.js` يثق بالترويسة بلا `trust proxy`. الإصلاح: ضبط `trust proxy` واعتماد `req.ip`.
- **H-3 — Socket بلا إعادة مصادقة:** `socket.js` يتحقق عند handshake فقط. الإصلاح: إعادة تحقق دورية / فصل عند الإبطال.
- **H-4 — `tripTimers` في الذاكرة → Ghost trips:** `driverMatcher.js`. مُخفَّف بتنظيف الإقلاع. الإصلاح: BullMQ/Redis.
- **H-5 — أذونات موقع Android غائبة:** `AndroidManifest.xml` بلا `ACCESS_*_LOCATION` — GPS معطّل على أندرويد. الإصلاح: إعلان الأذونات + طلب runtime.
- **H-6 — توقيع الإصدار بمفاتيح debug:** `build.gradle.kts` — يحجب النشر على Play. الإصلاح: keystore إنتاج.
- **H-7 — رمز أدمن MCP في `/tmp` بصلاحيات 0644:** `token-manager.ts`. الإصلاح: كتابة بـ `mode: 0o600` أو مجلد مقيّد.
- **H-8 — لا HTTPS/Docker:** الإصلاح: Dockerfile + reverse proxy TLS.

---

## 18. النتائج المتوسطة (🟡 MEDIUM)

- **M-1 — `sanitize()` يُتلف بيانات شرعية:** حذف `[<>"';()&+]` عالمياً من كل body. الإصلاح: output encoding + الاعتماد على params.
- **M-2 — غياب FK رغم PRAGMA:** بيانات يتيمة ممكنة.
- **M-3 — امتياز أدمن يبقى 24h بعد إزالة الرقم:** `authenticateAdmin` يقبل `role='admin'` من token. الإصلاح: فحص `ADMIN_PHONES` دائماً.
- **M-4 — قوائم الأسطول عامة:** `/taxis`, `/scooters` بلا مصادقة تكشف المواقع الحية.
- **M-5 — مفتاح Maps حيّ غير مُقيَّد على القرص.** الإصلاح: تقييد نطاق + تدوير.
- **M-6 — تغطية اختبار Flutter شبه صفر.**
- **M-7 — God routers / ملفات ضخمة.**
- **M-8 — `broadcast()` بلا throttling** (استنزاف موارد عند البثّ الواسع).
- **M-9 — معرّف تطبيق `com.example.oncall_app`** يحجب النشر.
- **M-10 — دخول MCP بالأدمن يتعارض مع `REQUIRE_OTP=true`** (قد يكسر MCP في الإنتاج).

---

## 19. النتائج المنخفضة (🟢 LOW)

- **L-1** جدول `wallets` ميت.
- **L-2** `database.js` جذري مقترن (schema+seed+فهارس).
- **L-3** Flutter re-export stubs مكرَّرة (5 ملفات).
- **L-4** `server.js` 255 سطر — انقل DI إلى container.
- **L-5** افتراضي `baseUrl` غير صالح للإنتاج (http/IP hotspot).
- **L-6** نسخ احتياطي محلي فقط (لا خارجي).
- **L-7** JWT يدوي (سليم لكن يتحمّل مخاطر صيانة).
- **L-8** `scripts/` فارغ + فوضى تقارير/اختبارات في الجذر.
- **L-9** `findNearestDriver` O(n) بلا فهرسة مكانية.

---

## 20. الإيجابيات الخاطئة (False Positives — فُحِصت وثبت أنها سليمة)

- **ملفات `.fuse_hidden*`** — بقايا FUSE mount، ليست ملفات مشروع.
- **`.env` مُسرَّب في git** — **خطأ**: مُتجاهَل ومُثبَت غيابه من التاريخ.
- **حقن SQL** — منتفٍ: parameterized queries في كل مكان.
- **alg:none في JWT** — منتفٍ: `verifyJWT` يُعيد حساب HS256 دائماً متجاهلاً ترويسة alg.
- **N+1 في driver stats** — منتفٍ: مُحوَّل إلى تجميع SQL واحد.
- **مفاتيح Maps مُرمَّزة في الموبايل** — منتفٍ: عبر placeholders من `local.properties`/`Info.plist`.
- **ثغرات تبعيات** — منتفٍ: `npm audit` = 0 في backend وMCP.
- **CORS `*` على Socket.IO** — مقبول للموبايل (لا Origin header)، والأمان الحقيقي عبر JWT middleware.

---

## 21. نتائج غير مُتحقَّقة (NOT VERIFIED)

- وجود reverse proxy / TLS / بنية نشر خارج المستودع.
- هل يُشغَّل MCP فعلاً في الإنتاج (يحدّد خطورة M-10 وH-7).
- سلوك دمج manifest في إصدار Android الفعلي بخصوص `INTERNET` (يُضاف عادة عبر plugins مثل firebase/maps؛ لم يُبنَ APK للتأكيد).
- أداء `flutter analyze` (لم يُشغَّل Flutter SDK في هذه البيئة).
- سلامة استرداد النسخ الاحتياطي فعلياً (منطق موجود، لم يُختبَر end-to-end هنا).

---

## 22. أعلى 25 حاجباً للإنتاج (Top 25 Production Blockers)

| # | المعرّف | العنوان | الخطورة |
|---|--------|--------|:-------:|
| 1 | C-1 | خطأ تزامن مالي على اتصال SQLite واحد | 🔴 |
| 2 | C-2 | استحالة التوسّع الأفقي (حالة في الذاكرة) | 🔴 |
| 3 | H-5 | أذونات موقع Android غائبة (GPS معطّل) | 🟠 |
| 4 | H-6 | توقيع الإصدار بمفاتيح debug | 🟠 |
| 5 | H-1 | PII (أرقام هواتف) في السجلات | 🟠 |
| 6 | H-7 | رمز أدمن MCP في /tmp بصلاحيات مفتوحة | 🟠 |
| 7 | H-8 | لا HTTPS/Docker | 🟠 |
| 8 | H-2 | تجاوز rate-limit عبر X-Forwarded-For | 🟠 |
| 9 | H-3 | Socket بلا إعادة مصادقة | 🟠 |
| 10 | H-4 | tripTimers في الذاكرة (Ghost trips) | 🟠 |
| 11 | M-9 | معرّف تطبيق com.example يحجب النشر | 🟡 |
| 12 | M-3 | امتياز أدمن يبقى 24h بعد الإزالة | 🟡 |
| 13 | M-1 | sanitize يُتلف بيانات شرعية | 🟡 |
| 14 | M-2 | غياب FK (بيانات يتيمة) | 🟡 |
| 15 | M-4 | قوائم الأسطول عامة (كشف مواقع) | 🟡 |
| 16 | M-10 | دخول MCP يتعارض مع REQUIRE_OTP | 🟡 |
| 17 | M-8 | broadcast بلا throttling | 🟡 |
| 18 | M-5 | مفتاح Maps غير مُقيَّد | 🟡 |
| 19 | M-6 | تغطية اختبار Flutter صفر | 🟡 |
| 20 | M-7 | God routers / ملفات ضخمة | 🟡 |
| 21 | L-6 | نسخ احتياطي محلي فقط | 🟢 |
| 22 | L-1 | جدول wallets ميت | 🟢 |
| 23 | L-2 | database.js جذري مقترن | 🟢 |
| 24 | L-5 | افتراضي baseUrl غير إنتاجي | 🟢 |
| 25 | — | جاهزية PostgreSQL منخفضة (اعتماد سلوكيات SQLite) | 🟢 |

---

## 23. خارطة طريق الإصلاح المرتَّبة

**المرحلة 0 — عاجل (قبل أي إطلاق):** C-1 (معاملة ذرية)، H-1 (تقنيع الهاتف)، H-2 (trust proxy)، H-5 (أذونات موقع Android)، H-6 (توقيع إنتاج)، H-7 (صلاحيات /tmp)، M-3 (فحص ADMIN_PHONES).

**المرحلة 1 — تصلّب أمني وموبايل (أسبوعان):** H-3، H-8 (Docker+TLS)، M-1، M-4، M-5، M-9 (معرّف التطبيق)، M-10.

**المرحلة 2 — الجاهزية للتوسّع (قبل النمو):** C-2 + H-4 (Redis + BullMQ)، الانتقال إلى Postgres مع FK (M-2)، M-8 (throttling)، L-6 (نسخ خارجي).

**المرحلة 3 — صيانة وجودة (مستمر):** M-6 (اختبارات Flutter + job في CI)، M-7 (تقسيم routers)، حذف الكود الميت (L-1/L-2/L-3/L-8)، L-4 (container).

---

## 24. تقدير الجهد الهندسي

| المرحلة | الجهد |
|---------|:-----:|
| 0 — عاجل | 3–4 أيام |
| 1 — أمني/موبايل | 1.5–2 أسبوع |
| 2 — توسّع (Redis+Postgres) | 3–4 أسابيع |
| 3 — صيانة/جودة | 2–3 أسابيع (تدريجي) |
| **الإجمالي حتى إنتاج واسع** | **≈ 6–9 أسابيع مهندس واحد** |

---

## 25. الحُكم النهائي

### ⚠️ Needs Improvements

- **إطلاق تجريبي (single-server، حِمل منخفض):** ممكن **بعد المرحلة 0 فقط** — خاصة C-1 (مالي)، H-1 (PII)، وH-5/H-6 (جاهزية Android). البنية مستقرة لنسخة واحدة.
- **إنتاج واسع / توافر عالٍ:** **Not Production Ready** حتى المرحلة 2. القيود المعمارية (الحالة في الذاكرة، SQLite، خطأ التزامن المالي) تمنع التشغيل متعدد النسخ بأمان.

**نقاط قوة تستحق الحفاظ:** فصل طبقات وDI نظيف، دفاع IDOR متسق (JWT-only identity)، عمليات ذرية للأموال/القبول/الفتح، refresh rotation، OTP hash-only، CI متعدد المراحل بصفر ثغرات تبعيات، iOS مُهيَّأ جيداً، وتوثيق داخلي غزير.

---

*نهاية التقرير — تدقيق قراءة فقط شامل للمستودع بالكامل. تم اجتياز جميع المجلدات (backend، Flutter، MCP، android، ios، docs، scripts، CI، configs). لم يُعدَّل أي كود.*
