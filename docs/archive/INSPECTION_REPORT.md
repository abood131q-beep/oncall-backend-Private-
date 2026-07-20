# تقرير الفحص الشامل للمشروع
**التاريخ:** 15 يوليو 2026  
**المشاريع:** oncall-backend · oncall_app (Flutter) · oncall-mcp (TypeScript)  
**المُنفِّذ:** جلسة CTO/Lead Engineer + QA Review

---

## ملخص الحالة العامة

| المشروع | البناء | الاختبارات | الأمان | الجودة |
|---------|--------|------------|--------|--------|
| `oncall-backend` | ✅ نظيف | ✅ 55/55 | ✅ جيد | ✅ ESLint 0 أخطاء |
| `oncall_app` (Flutter) | ✅ نظيف | — | ✅ JWT على كل request | ⚠️ ملاحظات |
| `oncall-mcp` | ✅ TypeScript يبني | — | ✅ TokenManager | ✅ 96 أداة مسجلة |

---

## 1. المشاكل المُصلَحة في هذه الجلسة

### 1.1 `getPlaceDetails()` — JWT header مفقود
- **الملف:** `lib/services/places_service.dart`
- **المشكلة:** `http.get()` في `getPlaceDetails()` كان يفتقر إلى `headers: SessionService.headers` مما يؤدي إلى 401 Unauthorized.
- **الإصلاح:** أُضيف `headers: SessionService.headers` ليتطابق مع `searchPlaces()`.
- **الخطورة:** 🔴 عالية — وظيفة Places كاملة معطّلة للمستخدمين المُسجَّلين.

### 1.2 Ghost Trips — رحلات `waiting_driver` تبقى في قاعدة البيانات بعد إعادة تشغيل السيرفر
- **السبب الجذري:** `tripTimers` هو `Map` في الذاكرة — يُفقَد عند كل إعادة تشغيل. رحلات بحالة `waiting_driver` تبقى في DB إلى الأبد.
- **الأعراض:** Flutter logs تُظهر رحلات 149–164 تُنضَم ثم تُلغى فوراً (socket `passenger:join` يُعيد الحالة الحالية من DB).
- **إصلاح Backend** (`server.js` — startup cleanup):
  ```js
  UPDATE trips SET status = 'no_driver'
  WHERE status = 'waiting_driver'
  AND created_at < datetime('now', '-10 minutes')
  ```
- **إصلاح Flutter** (`passenger_taxi_page.dart` — `_checkActiveTrip()`):
  - تصفية الرحلات الأقدم من 10 دقائق قبل الانضمام إليها.
  - الانتقال مباشرة إلى `PassengerTrackingPage` بدلاً من تحديث حالة محلية.
- **الخطورة:** 🔴 عالية — UX محطّم (المستخدم يُحاط بحلقة انضمام/إلغاء عند كل فتح للصفحة).

### 1.3 `wallet_page.dart` — خطأ في string interpolation
- **الملف:** `lib/wallet_page.dart`
- **المشكلة:** `'$SessionService.phone'` في Dart يُقحِم `SessionService` (كـ Type object) ثم يُلحق `.phone` كنص حرفي، مما يُنتج URL خاطئاً مثل `/wallet/transactions/Type 'SessionService'.phone`.
- **الإصلاح:** تغيير إلى `'${SessionService.phone}'`.
- **الخطورة:** 🔴 عالية — صفحة المحفظة كانت لا تُحمِّل المعاملات نهائياً (الـ backend يُعيد 403 بسبب عدم تطابق الـ phone في URL مع JWT).

### 1.4 Prettier drift — `logger.js` و `server.js`
- **المشكلة:** تنسيق يدوي أحدث انحرافاً عن إعدادات Prettier → 129 خطأ تنسيق.
- **الإصلاح:** `npx prettier --write 'src/**/*.js' server.js`
- **الخطورة:** 🟡 متوسطة — يكسر CI lint check.

### 1.5 ESLint false positives — `Promise.allSettled` و `Object.fromEntries`
- **الملف:** `.eslintrc.js`
- **المشكلة:** `plugin:node/recommended` مُهيَّأ لـ Node >=8 → يُصدر أخطاء وهمية.
- **الإصلاح:** `'node/no-unsupported-features/es-builtins': 'off'` (المشروع على Node 22).
- **الخطورة:** 🟡 متوسطة — يمنع eslint --exit-zero من النجاح في CI.

### 1.6 Import path خاطئ في `passenger_taxi_page.dart`
- **المشكلة:** كانت تستورد `package:oncall_app/places_service.dart` (re-export stub قديم) بدلاً من المسار الأصلي.
- **الإصلاح:** تغيير إلى `package:oncall_app/services/places_service.dart`.
- **الخطورة:** 🟢 منخفضة — كان يعمل عبر re-export لكن المسار المباشر أوضح وأنظف.

---

## 2. مشاكل مكتشفة لم تُصلَح بعد

### 🔴 عالية الخطورة

#### 2.1 OTP SMS غير مُفعَّل للإنتاج
- **الملف:** `src/routes/auth.js` (أو notificationService)
- **الوضع الحالي:** OTP يُطبَع في `logger.warn` فقط — لا يصل للمستخدم.
- **المطلوب:** ربط Twilio / Unifonic / AWS SNS عندما `REQUIRE_OTP=true`.
- **الأثر:** نظام المصادقة بالـ OTP غير فعّال في بيئة الإنتاج.

#### 2.2 `GOOGLE_MAPS_API_KEY` غير مُعيَّن
- **الوضع الحالي:** المشروع يتعامل معه gracefully (يُعيد رسالة خطأ واضحة)، لكن Places autocomplete معطّل كلياً.
- **المطلوب:** إعداد مفتاح API وتقييد نطاقه في Google Cloud Console.

---

### 🟡 متوسطة الخطورة

#### 2.3 `lib/config.dart` — IP مُرمَّز بشكل ثابت
```dart
const String baseUrl = 'http://172.20.10.2:3000'; // hotspot IP
```
- **المطلوب:** قراءة من متغير بيئة أو ملف config وقت البناء (`--dart-define=BASE_URL=...`).
- **الأثر:** التطبيق لا يعمل إلا على شبكة hotspot واحدة.

#### 2.4 `admin_dashboard.dart` — `_DColors` منفصلة عن `AppTheme`
- **الوضع الحالي:** ألوان مُكرَّرة في `_DColors` داخل `admin_dashboard.dart` بدلاً من استخدام `AppTheme`.
- **المطلوب:** دمج `_DColors` في `AppTheme` لمصدر ألوان موحَّد.

#### 2.5 `passenger_home_page.dart` — أرقام هواتف المشرفين مُرمَّزة
```dart
final adminPhones = ['112', '99999999', 'admin'];
```
- **الوضع الحالي:** فحص على مستوى الـ UI فقط كـ guard بصري — الـ backend يتحقق بشكل مستقل.
- **المطلوب:** جلب القائمة من endpoint خاص `/admin/config` لتجنب إعادة البناء عند كل تغيير.

#### 2.6 `database.js` في الجذر — ملف ميت
- **الملف:** `/oncall-backend/database.js`
- **الوضع الحالي:** غير مُستورَد من أي مكان — بقايا من مرحلة تطوير سابقة.
- **المطلوب:** حذف آمن.

---

### 🟢 منخفضة الخطورة

#### 2.7 `server.js` أكبر من المطلوب (255 سطر)
- الهدف الأصلي كان ~70 سطر entry point — نما مع الوقت.
- يمكن نقل الـ DI setup إلى `src/container.js` مستقبلاً.

#### 2.8 `tripTimers` لا يزال عُرضة للفقدان عند إعادة التشغيل
- الإصلاح الحالي (cleanup عند الـ startup) يعالج الأثر لكن ليس السبب.
- **حل مستقبلي:** استبدال `setTimeout` في `driverMatcher.js` بـ Bull/BullMQ queue مُخزَّنة في Redis.

---

## 3. نتائج الفحص الأمني

| النقطة | الحالة | التفاصيل |
|--------|--------|----------|
| JWT Authentication | ✅ | كل route حساس يستخدم `authenticate` middleware |
| IDOR Protection | ✅ | جميع الـ routes تعتمد `req.user.phone` من JWT كمصدر وحيد للحقيقة |
| SQL Injection | ✅ | SQLite3 parameterized queries في كل مكان |
| Rate Limiting | ✅ | `loginLimit` + `phoneLoginLimit` + `normalLimit` مُطبَّقة |
| Input Validation | ✅ | `validatePhone` + `validateCoords` + `sanitizeBody` |
| Refresh Token Revocation | ✅ | P6-01: مُخزَّن في DB، يُحمَّل عند الـ startup |
| Socket.IO Auth | ✅ | JWT middleware على كل socket connection |
| Admin Routes | ✅ | `authenticateAdmin` يتحقق من `ADMIN_PHONES` env var |
| CORS | ✅ | `'*'` مقبول لـ Flutter mobile (لا origin في mobile clients) |
| Error Handling | ✅ | Global error handler في `server.js` يغطي 400/413/500 |
| Race Conditions | ✅ | `_joinedPassengerTrips` Set يمنع join مزدوج |
| Resource Leaks | ✅ | Graceful shutdown يُغلق Socket.IO ثم HTTP server |

---

## 4. نتائج فحص الأداء

| النقطة | الحالة | التفاصيل |
|--------|--------|----------|
| Cache Service | ✅ | `getCache/setCache` مُفعَّل للـ trips و drivers |
| DB Indexes | ✅ | Migration تُنشئ indexes على `trips(status)`, `drivers(status)` |
| Backup Schedule | ✅ | WAL checkpoint + backup دوري |
| Metrics Middleware | ✅ | `/metrics` endpoint يُتابَع request count + latency |
| `Promise.allSettled` | ✅ | يُستخدَم في `notificationService` لأداء أفضل |
| Socket Rooms | ✅ | `trip:{id}`, `driver:{phone}`, `drivers:online` مُنظَّمة |

---

## 5. إحصائيات المشروع

### Backend (`oncall-backend`)
- **الملفات:** ~45 ملف JavaScript
- **Routes:** 9 ملفات route
- **Repositories:** 7 (User, Driver, Scooter, Trip, Wallet, Notification, Report)
- **Services:** backup, cache, fareCalculator, driverMatcher, notificationService
- **Middleware:** auth, rateLimiter, metrics, setup
- **اختبارات:** 55 اختباراً — كلها تنجح
- **ESLint:** 0 أخطاء، 0 تحذيرات

### Flutter App (`oncall_app`)
- **الصفحات الرئيسية:** passenger_home, passenger_taxi, passenger_tracking, driver_home, driver_tracking, admin_dashboard, wallet, auth
- **Services:** session_service, socket_service, places_service
- **JWT:** مُرسَل في كل request عبر `SessionService.headers`
- **Stale-trip filter:** رحلات > 10 دقائق مُتجاهَلة في `_checkActiveTrip()`

### MCP Server (`oncall-mcp`)
- **أدوات:** 96 أداة عبر 10 ملفات TypeScript
- **التوزيع:** users(8), drivers(6), scooters(9), taxi(2), trips(14), admin(15), payments(6), engineering(28), places(2), auth(6)
- **بناء TypeScript:** نظيف بدون أخطاء
- **TokenManager:** يُجدِّد token تلقائياً عند انتهاء الصلاحية

---

## 6. قائمة الإجراءات المطلوبة

### الأولوية الأولى (قبل الإطلاق في الإنتاج)
1. [ ] **إعداد SMS provider** لإرسال OTP فعلي (Twilio / Unifonic)
2. [ ] **إعداد `GOOGLE_MAPS_API_KEY`** في `.env` وفي Flutter build config
3. [ ] **إصلاح `lib/config.dart`** — استبدال IP الثابت بـ `--dart-define=BASE_URL=...`

### الأولوية الثانية (قريباً)
4. [ ] **حذف `database.js`** من جذر المشروع (ملف ميت)
5. [ ] **دمج `_DColors`** في `AppTheme` في `admin_dashboard.dart`
6. [ ] **نقل admin phones** إلى endpoint خاص بدلاً من hardcoding في Flutter

### الأولوية الثالثة (تحسين مستقبلي)
7. [ ] **استبدال `tripTimers` Map** بـ Bull/BullMQ queue (Redis) لضمان الاستمرارية
8. [ ] **تفكيك `server.js`** — نقل Dependency Injection إلى `src/container.js`
9. [ ] **إضافة Flutter unit tests** لـ `_checkActiveTrip()` و socket handlers
10. [ ] **إضافة integration tests** للـ taxi flow كاملاً (request → accept → complete)

---

## 7. تاريخ الإصلاحات في هذه الجلسة

| # | الإصلاح | الملف | الحالة |
|---|---------|-------|--------|
| 1 | JWT header في `getPlaceDetails()` | `lib/services/places_service.dart` | ✅ مُطبَّق |
| 2 | Ghost trips — startup SQL cleanup | `server.js` | ✅ مُطبَّق |
| 3 | Ghost trips — stale-trip filter + direct navigation | `lib/pages/passenger_taxi_page.dart` | ✅ مُطبَّق |
| 4 | Dart string interpolation bug في wallet | `lib/wallet_page.dart` | ✅ مُطبَّق |
| 5 | Prettier format drift | `src/utils/logger.js` + `server.js` | ✅ مُطبَّق |
| 6 | ESLint false positives (Node builtins) | `.eslintrc.js` | ✅ مُطبَّق |
| 7 | Import path في `passenger_taxi_page.dart` | `lib/pages/passenger_taxi_page.dart` | ✅ مُطبَّق |

---

*نهاية التقرير — المشروع في حالة مستقرة وجاهز للتطوير المستمر.*
