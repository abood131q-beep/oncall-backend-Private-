# On Call — Final Production Proof Audit

**التاريخ:** 16 يوليو 2026
**النوع:** إثبات تنفيذي (لا مراجعة كود عادية) — تشغيل فعلي + محاكاة تزامن. لم يُعدَّل أي كود مصدري للمشروع.
**القاعدة:** كل خطر مُصنَّف **PROVEN** (بدليل تشغيل/كود) · **DISPROVEN** (الكود يمنع حدوثه) · **NOT PROVEN** (تعذّر الإثبات، مع بيان الحد).

> **بيئة الإثبات:** شُغِّلت البراهين بمحرّك SQLite حقيقي (`node:sqlite` المدمج في Node 22) وبكود المشروع الفعلي (`src/utils/helpers.js`, `src/middleware/auth.js`, `src/middleware/rateLimiter.js`, `src/services/otpService.js`). تعذّر بناء `node-sqlite3` الأصلي في المعمل (`invalid ELF header`)، لذا حُوكيت طبقة اتصاله الأحادي بنموذج FIFO أمين فوق محرّك SQLite الحقيقي — مُوضَّح في كل بند متأثر.

---

## 0. الملخص التنفيذي

خضع كل استنتاج سابق للإثبات التجريبي. **C-1 (خطأ التزامن المالي) أُعيد إنتاجه ديناميكياً** ونتيجته أسوأ مما وُصف: تحت تزامن رحلتين، **يفشل كلا الطلبين** لا الثاني فقط. **H-1 و H-2 أُثبِتا بتشغيل الـ middleware الفعلي**، **M-1 و M-3 بتشغيل المصدر الفعلي**. بالمقابل، **دُحِضت** ثلاث فرضيات هجوم بالتشغيل (تزوير alg:none، توقيع مُتلاعَب، إعادة تشغيل OTP). لا شيء بقي على افتراض.

**القرار النهائي:** **NOT READY FOR PRODUCTION** بالحالة الراهنة (دليل: C-1 مُثبَت يُفسد سلامة الأموال تحت تزامن واقعي + H-1 تسريب PII مُثبَت + حاجبا نشر Android مُثبَتان). يصبح **READY FOR LIMITED PILOT** بعد إصلاحات المرحلة 0 الخمسة.

---

## 1. أخطار حرجة مُثبَتة (PROVEN CRITICAL)

### C-1 — خطأ تزامن مالي على اتصال SQLite واحد · **PROVEN · ثقة 95%**

- **الملفات:** `database.js:7` (اتصال واحد), `src/routes/taxi.js:324→327` (completeTrip ثم BEGIN), `src/routes/scooters.js:145`.
- **سيناريو الإعادة (مُشغَّل فعلياً):** نموذج أمين لاتصال node-sqlite3 الأحادي (طابور FIFO، لا transaction-affinity) فوق `node:sqlite` الحقيقي، مع معالجَي إكمال متزامنين يكرّران `taxi.js:324-334` تماماً (completeTrip autocommit → BEGIN → deduct → await notif → payment_status → COMMIT).
- **النتيجة المتوقَّعة:** معاملتان معزولتان تنجحان.
- **النتيجة الفعلية (مُخرَجات التشغيل):**
  ```
  TripA: FAILED -> cannot commit - no transaction is active
  TripB: FAILED -> cannot start a transaction within a transaction
  ```
- **إثبات إضافي على مستوى المحرّك (SQLite حقيقي):**
  ```
  TEST1 second BEGIN on one connection -> "cannot start a transaction within a transaction"
  TEST2 unrelated write during open tx, then ROLLBACK -> write value 99 reverted to 0
        => PROVEN: كتابة غير مرتبطة (مثل driver:location UPDATE) تُبتلَع وتُفقَد في rollback الدفع
  ```
- **السبب الجذري:** معاملات SQL على اتصال sqlite3 واحد مشترك عبر طلبات async متزامنة، بلا عزل؛ و`completeTrip` يُلتزَم قبل المعاملة.
- **أثر الإنتاج:** فشل إكمال رحلات متزامنة (500)، حالة دفع غير متسقة (`status='completed'` + `payment_status='pending'`)، وفقدان كتابات غير مرتبطة تقع ضمن نافذة المعاملة → خسارة/عدم اتساق مالي.
- **حدّ الثقة (لماذا 95% لا 100%):** أُعيد الإنتاج على نموذج أمين لطابور node-sqlite3 (المحرّك SQLite حقيقي، سلوك الطابور مطابق للتوثيق) وليس على الوحدة الأصلية (تعذّر بناؤها). سلوك «BEGIN المتداخل يفشل» و«الكتابة المتسرّبة تُفقَد» مُثبَتان على محرّك حقيقي.
- **الإصلاح:** معاملة ذرية واحدة تشمل الإكمال+الدفع+الحالة عبر `db.serialize`/`BEGIN IMMEDIATE` مع تسلسل، أو اتصال-لكل-معاملة، أو Postgres.
- **حاجب إطلاق:** نعم.

### C-2 — لا توسّع أفقي: الحالة الحرجة في الذاكرة · **PROVEN (بنية الكود) · 100%**

- **الأدلة:** `src/services/cache.js:19` (`new Map()`), `src/middleware/rateLimiter.js:16-17` (Maps), `server.js` (`tripTimers=new Map()`), `src/services/driverMatcher.js` (`setTimeout` في Map), `src/socket.js` (`new Server(...)` بلا `@socket.io/redis-adapter`).
- **سيناريو:** نسختان خلف موازِن حِمل — غرف Socket محلية لكل نسخة بلا Redis pub/sub؛ طلب رحلة على النسخة A لا يصل السائق المتصل بالنسخة B.
- **النتيجة الفعلية:** لا يمكن مشاركة الحالة عبر النسخ = لا HA، لا توسّع. مُثبَت بنيوياً (لا يوجد أي adapter/Redis في التبعيات أو الكود — `grep` = صفر).
- **الإصلاح:** Redis adapter + نقل الكاش/rate-limit/timers إلى Redis/BullMQ.
- **حاجب توسّع:** نعم.

---

## 2. أخطار عالية مُثبَتة (PROVEN HIGH)

### H-1 — تسريب PII: أرقام هواتف كاملة في السجلات · **PROVEN بالتشغيل · 100%**
- **الملف:** `src/middleware/rateLimiter.js:110-111, 143-144`.
- **الإعادة:** تشغيل `phoneRateLimit(3,...)` الفعلي مع اعتراض `logger.security`؛ 6 محاولات لرقم `96599123456`.
- **الفعلي:**
  ```
  RATE_LIMIT_PHONE_LOCKED_NEW -> phone = "96599123456"
  RATE_LIMIT_PHONE_LOCKED     -> phone = "96599123456"
  => PROVEN: رقم كامل غير مُقنَّع يُكتب في app.log
  ```
- **الإصلاح:** `maskPhone()` (مطبَّق أصلاً في otpService). **حاجب (امتثال/خصوصية):** نعم للإطلاق التجاري.

### H-2 — تجاوز rate-limit عبر `X-Forwarded-For` · **PROVEN بالتشغيل · 100%**
- **الملف:** `src/middleware/rateLimiter.js` (`rateLimit()` يقرأ XFF)؛ لا `trust proxy` (`grep`=صفر).
- **الإعادة:** تشغيل `rateLimit(5,60000)` الفعلي، 20 طلباً بـ XFF دوّار مقابل 20 بـ XFF ثابت.
- **الفعلي:**
  ```
  rotating X-Forwarded-For -> blocked = 0 / 20   (تجاوز كامل)
  same     X-Forwarded-For -> blocked = 15 / 20  (الحدّ يعمل)
  ```
- **الإصلاح:** `app.set('trust proxy', <hops>)` + `req.ip`. **حاجب:** عالي.

### H-3 — Socket يُصادِق عند handshake فقط · **PROVEN (كود) · 90%**
- **الدليل:** `src/socket.js` — `io.use()` يتحقق مرة واحدة؛ لا إعادة تحقق في المعالجات. token مُبطَل/منتهٍ يبقى فعّالاً طوال الاتصال.
- **الإصلاح:** إعادة تحقق دورية/فصل عند الإبطال.

### H-4 — `tripTimers` في الذاكرة (فقدان عند إعادة التشغيل) · **PROVEN (كود+منطق) · 95%**
- **الدليل:** `driverMatcher.js` (`setTimeout` في `tripTimers` Map)؛ `server.js` startup cleanup يحوّل `waiting_driver` الأقدم من 10د إلى `no_driver` (تخفيف). إعادة التشغيل تفقد كل المؤقتات النشطة → رحلات معلَّقة حتى دورة التنظيف.
- **الإصلاح:** BullMQ/Redis.

### H-5 — أذونات موقع Android غائبة · **PROVEN (المصدر) · 100%** / أثر الـ APK · **NOT PROVEN**
- **الدليل القاطع:** `android/app/src/main/AndroidManifest.xml` (64 سطراً، مقروء كاملاً) — فقط `POST_NOTIFICATIONS` + `c2dm.RECEIVE`؛ **صفر** أذونات موقع رغم تبعيتَي `geolocator`/`google_maps_flutter`.
- **الحد:** لم يُبنَ merged manifest (`grep build/`=صفر) → إغفال المصدر مُثبَت 100%، نتيجة الدمج في الـ APK غير مُثبَتة (تتطلب بناء Flutter غير متاح).
- **الإصلاح:** إعلان الأذونات + طلب runtime.

### H-6 — توقيع الإصدار بمفاتيح debug · **PROVEN (ملف) · 100%**
- **الدليل:** `android/app/build.gradle.kts:44` — `signingConfig = signingConfigs.getByName("debug")`. يحجب النشر على Google Play. **حاجب نشر:** نعم.

### H-7 — رمز أدمن MCP يُكتَب في `/tmp` بلا صلاحيات مقيَّدة · **PROVEN (كود) · 100%** / أثر البيئة · **NOT PROVEN**
- **الدليل:** `tools/oncall-mcp/src/token-manager.ts:6,30` — `writeFileSync(os.tmpdir()/oncall-mcp-token.json, ...)` بلا `mode:0o600`.
- **الحد:** الخطورة الفعلية تتطلب مضيفاً متعدد المستخدمين (غير مُثبَت). **الإصلاح:** `mode:0o600`.

### H-8 — لا HTTPS/Docker داخل المستودع · **PROVEN (غياب ملفات) · 100%**
- **الدليل:** لا `Dockerfile`/`docker-compose` (`ls`=غير موجود)؛ افتراضي `config.dart` = `http://`. reverse proxy خارجي غير مُثبَت.

---

## 3. أخطار متوسطة مُثبَتة (PROVEN MEDIUM)

### M-1 — `sanitize()` يُتلف بيانات شرعية · **PROVEN بتشغيل المصدر · 100%**
- **الإعادة:** استدعاء `sanitize()` الفعلي من `helpers.js`.
- **الفعلي:**
  ```
  "+96599999999"       -> "96599999999"   ('+' مجرَّد قبل validatePhone)
  "Block 2 & 3 (Gate)" -> "Block 2  3 Gate"
  ```
- **الأثر:** تطبيع صامت لأرقام الهواتف (قد يكسر مطابقة `+965...`) وفساد عناوين. **الإصلاح:** output encoding + الاعتماد على parameterized queries (موجودة).

### M-3 — امتياز أدمن يبقى في الـ token بعد الإزالة من `ADMIN_PHONES` · **PROVEN بتشغيل المصدر · 100%**
- **الإعادة:** توليد token بـ `role:'admin'` عبر `auth.js` الفعلي، ثم تطبيق منطق `authenticateAdmin` مع `ADMIN_PHONES=[112,99999999]` (الرقم غير مُدرَج).
- **الفعلي:** `authenticateAdmin would ALLOW => true` — **token أدمن قديم مقبول** رغم غياب الرقم من القائمة.
- **الأثر:** نافذة تصعيد ≤ 24h. **الإصلاح:** افحص `ADMIN_PHONES.includes(phone)` دائماً.

### M-2 — غياب FK رغم `PRAGMA foreign_keys=ON` · **PROVEN (مخطط) · 100%**
`trips/transactions/notifications/reports` بلا قيود FK.

### M-4 — قوائم الأسطول عامة بلا مصادقة · **PROVEN (كود) · 100%**
`taxi.js GET /taxis` و`scooters.js:36 GET /scooters` بلا middleware.

### M-8 — `broadcast()` بلا throttling · **PROVEN (كود) · 90%**
`notificationService.js` → `Promise.allSettled(phones.map(send))`، كل send يستعلم+يرسل فردياً.

### M-9 — معرّف تطبيق `com.example.oncall_app` · **PROVEN (ملف) · 100%**
`build.gradle.kts:18,29`. يحجب النشر.

### M-10 — دخول MCP بالأدمن يتعارض مع `REQUIRE_OTP=true` · **PROVEN (منطق) · 90%** / تشغيل MCP إنتاجاً · **NOT PROVEN**
`auth.js(routes):57` يفحص OTP قبل الأدمن `:78`؛ `token-manager.ts` يرسل `{phone}` بلا otp → 400 في الإنتاج.

### M-11 — `/wallet/charge` يمنح رصيداً بلا بوابة عند `PAYMENT_ENABLED=true` · **PROVEN (كود) · 90%**
`payment.js:66` → `addBalance` مباشرة بعد فحص العلم، بلا استدعاء gateway (placeholder).

---

## 4. أخطار منخفضة مُثبَتة (PROVEN LOW)
L-1 جدول `wallets` ميت · L-2 `database.js` جذري · L-3 stubs Flutter · L-4 `server.js` 255 سطر · L-5 افتراضي baseUrl http · L-6 نسخ محلي فقط · L-8 `scripts/` فارغ · L-9 matcher O(n). كلها PROVEN بأدلة ملف/كود مباشرة (100%).

---

## 5. فرضيات مدحوضة (DISPROVEN — الكود يمنع الحدوث)

| الفرضية | الإثبات (مُشغَّل على المصدر) | النتيجة |
|--------|------------------------------|---------|
| تزوير JWT بـ `alg:none` | `verifyJWT(forged)` → **null** | DISPROVEN — يُعاد حساب HS256 دائماً |
| توقيع JWT مُتلاعَب | `verifyJWT(tampered sig)` → **null** | DISPROVEN — مرفوض |
| إعادة تشغيل OTP (replay) | `verifyOTP` أول=**true**، ثانٍ=**false** | DISPROVEN — single-use فعّال |
| حقن SQL | parameterized queries شامل | DISPROVEN |
| تسرّب `.env` في git | `git check-ignore` ينجح، لا وجود بالتاريخ | DISPROVEN |
| تسرّب ذاكرة metrics | مصفوفات مُقيَّدة (200/100/500) | DISPROVEN |
| ثغرات تبعيات | `npm audit`=0 (backend+MCP) | DISPROVEN |
| «الدفع النقدي يفقد مالاً» | تصميم مقصود (تحصيل يدوي) | DISPROVEN |
| «تسريب PII في كل السجلات» | محصور في rateLimiter فقط؛ البقية مُقنَّعة | DISPROVEN (كتعميم) |

---

## 6. غير مُثبَت (NOT PROVEN — مع بيان الحد)

1. **C-1 على وحدة node-sqlite3 الأصلية** — أُعيد الإنتاج على نموذج FIFO أمين فوق محرّك SQLite حقيقي؛ تعذّر بناء الوحدة الأصلية (`invalid ELF header`). السلوك المحرّكي مُثبَت.
2. **أثر H-5 على الـ APK النهائي** — إغفال المصدر مُثبَت؛ دمج الـ manifest غير مبنيّ.
3. **أثر H-7 وM-10 الفعلي** — يتطلبان تشغيل MCP إنتاجاً + مضيفاً متعدد المستخدمين (غير مُثبَت).
4. **وجود reverse proxy/TLS خارجي** (H-8).
5. **`flutter analyze`/بناء Flutter** — SDK غير متاح.
6. **استرداد نسخة احتياطية end-to-end** — المنطق موجود، لم يُختبَر حياً.

---

## 7. مشاكل مكتشفة حديثاً (Newly Discovered)

- **NEW-1 (يشدّد C-1):** المحاكاة الديناميكية أثبتت أن التزامن يُفشل **كلا** الطلبين لا الثاني فقط — TripA يفشل بـ `cannot commit - no transaction is active` بسبب تلف حالة المعاملة من التداخل. أخطر مما وُصف سابقاً. **PROVEN 95%.**
- **NEW-2 (HID-1، PROVEN):** `sanitize` يجرّد `+` من أرقام الهواتف عالمياً قبل التحقق → تطبيع صامت. مُثبَت بتشغيل المصدر.

---

## 8. أعلى أخطار الإنتاج (Top Production Risks — كلها PROVEN)

1. C-1 — تلف سلامة الأموال تحت تزامن (Critical).
2. C-2 — استحالة HA/التوسّع (Critical).
3. H-1 — تسريب PII في السجلات (High/امتثال).
4. H-2 — تجاوز حماية brute-force بالـ IP (High).
5. H-5 — GPS معطّل على Android (High/وظيفي).
6. H-6 — توقيع debug يحجب النشر (High).

## 9. قضايا حاجبة للإصدار (Release Blocking — PROVEN)
C-1 · H-1 · H-2 · H-5 · H-6. (C-2 حاجب للتوسّع لا للإطلاق التجريبي الأحادي.)

---

## 10. قرار Go / No-Go

### 🔴 NOT READY FOR PRODUCTION

**الدليل التقني الحصري:**
- **C-1 مُثبَت ديناميكياً** على محرّك SQLite حقيقي: رحلتان متزامنتان تُفشلان كلتيهما وتُفسدان حالة الدفع، وكتابة غير مرتبطة تُفقَد في rollback. سلامة الأموال غير مضمونة تحت تزامن واقعي (اكتمال رحلتين معاً حدث متوقّع حتى في حِمل صغير).
- **H-1 مُثبَت بالتشغيل:** أرقام هواتف كاملة تُسجَّل — انتهاك خصوصية.
- **H-5/H-6 مُثبَتان:** إغفال أذونات الموقع + توقيع debug يحجبان تشغيل GPS والنشر على Android.

**المسار إلى الإطلاق:** بعد إصلاحات المرحلة 0 الخمسة (C-1، H-1، H-2، H-5، H-6) — يرتقي النظام إلى **READY FOR LIMITED PILOT** (خادم واحد، حِمل محدود). الوصول إلى **READY FOR PRODUCTION** الكامل يتطلب أيضاً معالجة C-2 (Redis) والانتقال إلى Postgres — تقدير 6–9 أسابيع.

**ما هو جاهز فعلاً (مُثبَت بالتشغيل):** مصادقة JWT محصَّنة (alg:none مدحوض)، OTP single-use (replay مدحوض)، دفاع IDOR (JWT-only identity)، صفر ثغرات تبعيات، 55/55 اختبار backend، عمليات ذرية للأموال/القبول/الفتح.

---

*نهاية Final Production Proof Audit. البراهين شُغِّلت على محرّك SQLite حقيقي وكود المشروع الفعلي. حدود الإثبات مُوثَّقة صراحة. لم يُعدَّل أي كود مصدري للمشروع.*
