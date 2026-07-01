# OnCall Backend — Full Engineering Audit Report
**Date:** 2026-07-01  
**Auditor:** CTO / Lead Engineer / Security Engineer / DevOps / QA Lead  
**Scope:** Complete codebase — Backend, DB, APIs, Auth, Security, Performance, Architecture, Code Quality  
**Mode:** READ-ONLY — No modifications made during audit

---

## Executive Summary

المشروع في حالة هندسية **جيدة نسبياً** مقارنةً بمرحلة البداية. تم إنجاز عمل ضخم في الأشهر الماضية: بنية Repository Pattern سليمة، Dependency Injection محكم، Socket.IO مُؤمَّن بـ JWT، وفصل واضح بين الطبقات. الأكواد مرتبة، مُوثَّقة، ومُختبرة بـ 45/45.

غير أن التدقيق كشف عن **6 مشاكل حرجة** تُشكّل خطراً أمنياً وتشغيلياً حقيقياً، و**7 مشاكل عالية** تحتاج معالجة قبل الإنتاج، بالإضافة إلى مشاكل متوسطة ومنخفضة.

**الحكم العام: المشروع غير مستعد للإنتاج حتى تُعالج المشاكل الحرجة والعالية.**

---

## Section Scores

| القسم | الدرجة | ملاحظة |
|-------|--------|--------|
| Architecture | 85/100 | بنية ممتازة — Repository + DI + Services |
| Code Quality | 82/100 | ESLint + Prettier + JSDoc + تنظيم جيد |
| Authentication & Authorization | 78/100 | JWT سليم، لكن token في URL + لا revocation |
| Logging & Monitoring | 78/100 | Logger مركزي جيد، لكن console.log مسرّب |
| API Design | 77/100 | RESTful منطقي، لكن info leak في /health |
| Error Handling | 75/100 | try/catch شامل، لكن بعض الـ 500 بلا log |
| Testing | 70/100 | 45/45 passing، لكن لا unit tests للـ services |
| Business Logic | 72/100 | Ownership checks جيدة، لكن لا phone verification |
| DevOps & Operations | 73/100 | Backup + Graceful shutdown، لكن execSync مشكلة |
| Performance & Scalability | 60/100 | SQLite أحادي، race conditions، in-memory فقط |
| Input Validation | 55/100 | sanitizeBody عالمي، لكن validatePhone() لا تُستدعى |
| Database Design | 65/100 | WAL + Indexes، لكن جداول وأعمدة ميتة كثيرة |
| Race Conditions & Concurrency | 50/100 | TOCTOU في unlock وacceptance وwallet |
| Dead Code & Technical Debt | 65/100 | wallets/login_logs unused، أعمدة ميتة كثيرة |
| **Secrets Management** | **30/100** | **🚨 JWT Secret + API Key حقيقيان في .env** |

**Overall Score: 69/100**

---

## Issues — Full List

### 🔴 CRITICAL

---

#### C-001 — Real Secrets Exposed in `.env`

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P0 — يجب إصلاحه فوراً |
| **الملف المتأثر** | `.env` |
| **السبب** | ملف `.env` يحتوي JWT_SECRET وGOOGLE_MAPS_API_KEY حقيقيَّين |
| **التأثير** | أي شخص يقرأ الملف (developer، git history، CI logs) يستطيع تزوير JWT tokens وانتحال هوية أي مستخدم — بما فيهم المديرون — إضافةً لاستنزاف حصة Google Maps API |
| **الوقت المتوقع** | 30 دقيقة |

**المشكلة:**
```
# .env (الحالي — خطير جداً)
JWT_SECRET=72813ef8f3ceceb11c07a49dfc34c5e417159b8cdd11c92086e635a42b653550
GOOGLE_MAPS_API_KEY=AIzaSyCFrnw402eLxZFqMFqwpCmk9cM4071OL74
ADMIN_PHONES=112,99999999   ← أرقام تجريبية في الإنتاج
```

**الإصلاح:**
1. أضف `.env` إلى `.gitignore` فوراً
2. غيّر JWT_SECRET وأعد تشغيل الخادم (جميع tokens الحالية ستنتهي)
3. أعد توليد Google Maps API Key من Google Cloud Console (وقيّد الـ key بـ IP أو Referrer)
4. استخدم `.env.example` كمرجع فقط — لا قيم حقيقية فيه أبداً

**المخاطر إذا لم تُصلح:** تزوير tokens، انتحال هوية المستخدمين والمديرين، استنزاف Google API quota، رسوم مالية إضافية.

---

#### C-002 — JWT Token Accepted via URL Query Parameter

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P0 |
| **الملف المتأثر** | `src/middleware/auth.js` L57 |
| **السبب** | `authenticate` middleware يقبل `req.query.token` |

**المشكلة:**
```js
// src/middleware/auth.js — السطر 57
const token =
  req.headers['authorization']?.replace('Bearer ', '') ||
  req.headers['x-session-token'] ||
  req.query.token;  // ← خطر: الـ token في URL
```

**التأثير:** الـ JWT يظهر في:
- سجلات الخادم (Nginx/Apache/Node access logs)
- تاريخ المتصفح (Browser History)
- Referrer Header عند الانتقال لموقع خارجي
- سجلات الـ proxy/CDN/load balancer
- حالات الـ cURL أو debugging tools

**الإصلاح:** احذف `req.query.token` من middleware. `Authorization: Bearer <token>` كافٍ.

```js
// الإصلاح
const token =
  req.headers['authorization']?.replace('Bearer ', '') ||
  req.headers['x-session-token'];
  // req.query.token محذوف
```

**المخاطر إذا لم تُصلح:** سرقة tokens من سجلات الخادم، session hijacking.

---

#### C-003 — No Phone Verification on Registration (Auto-Create + Free Balance)

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P0 |
| **الملفات المتأثرة** | `src/routes/auth.js`, `src/repositories/UserRepository.js` |
| **السبب** | POST /login ينشئ حساباً لأي رقم هاتف بدون تحقق OTP، ويعطيه 10 KD تلقائياً |

**المشكلة:**
```js
// src/routes/auth.js
let user = await userRepo.findByPhone(phone);
if (!user) {
  user = await userRepo.create(phone, name);  // ← ينشئ حساباً لأي رقم
}
// UserRepository.create:
await dbRun('INSERT INTO users (phone, name, balance) VALUES (?, ?, 10)', [...]);
//                                                          balance = 10 KD مجاناً ←
```

**التأثير:** أي مهاجم يستطيع:
1. إنشاء آلاف الحسابات برموز هواتف وهمية
2. الحصول على 10 KD × عدد الحسابات
3. استخدام حسابات وهمية لتزوير التقييمات

نفس المشكلة للسائقين — `POST /driver/login` ينشئ سائقاً جديداً بلا تحقق.

**الإصلاح:** OTP verification قبل إنشاء الحساب. في المرحلة الأولى: على الأقل حذف الـ 10 KD الابتدائية حتى يكتمل ربط بوابة الدفع.

**المخاطر إذا لم تُصلح:** احتيال مالي، استنزاف الرصيد، تزوير التقييمات.

---

#### C-004 — Race Condition (TOCTOU) in Scooter Unlock

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P1 |
| **الملف المتأثر** | `src/routes/scooters.js` — POST /scooter/unlock |
| **السبب** | Check status ثم Lock منفصلتان — بدون transaction/mutex |

**المشكلة:**
```js
// POST /scooter/unlock
const scooter = await scooterRepo.findById(scooterId);   // [1] Check
if (scooter.status !== 'available') return 400;           // [1] Check
// ← نافذة زمنية يستطيع مستخدم آخر فيها قراءة نفس الـ status
await scooterRepo.setRiding(scooterId, phone, startTime); // [2] Lock
```

مستخدمان يرسلان unlock في نفس اللحظة — كلاهما يجتاز الـ check، كلاهما ينجح في setRiding.

**الإصلاح:**
```sql
-- استخدم UPDATE مشروطة (Conditional Update) كـ atomic test-and-set
UPDATE scooters
SET status='riding', current_user_phone=?, ride_start_time=?
WHERE id=? AND status='available'
-- تحقق من this.changes === 1 (عملية ناجحة) أو 0 (race — ارجع 409)
```

**المخاطر إذا لم تُصلح:** مستخدمان يفتحان نفس السكوتر، فوضى في الفوترة، خسارة مالية.

---

#### C-005 — Race Condition (TOCTOU) in Trip Acceptance

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P1 |
| **الملف المتأثر** | `src/routes/taxi.js` — PUT /taxi/trips/:id/status (accepted) |
| **السبب** | نفس نمط TOCTOU — check status ثم update منفصلتان |

**المشكلة:**
```js
if (trip.status !== 'waiting_driver') return 400;  // [1] Check
// ← نافذة — سائقان يجتازان الـ check في نفس الوقت
await tripRepo.acceptByDriver(tripId, ...);         // [2] Write — كلاهما يكتب!
```

**الإصلاح:**
```sql
UPDATE trips SET status='accepted', driver_id=?, driver_name=?
WHERE id=? AND status='waiting_driver'
-- تحقق من this.changes === 1
```

**المخاطر إذا لم تُصلح:** رحلة واحدة تُقبل من سائقَين، تضارب في البيانات.

---

#### C-006 — `/admin/db/restore` Replaces Live Database Without Draining Connections

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | CRITICAL |
| **الأولوية** | P1 |
| **الملف المتأثر** | `src/routes/admin.js` — POST /admin/db/restore |
| **السبب** | `fs.copyFileSync(backupFile, dbFile)` يستبدل oncall.db وعملية Node.js لا تزال تستخدم الـ connection القديم |

**المشكلة:**
```js
// admin.js
require('fs').copyFileSync(backupFile, dbFile);  // ← يستبدل الملف على القرص
// لكن: const db = require('../../database') — الـ connection لا يزال مفتوحاً على الملف القديم!
```

في WAL mode، هذا يُفسد قاعدة البيانات بسبب WAL file mismatch.

**الإصلاح:**
1. استخدم SQLite's `.backup()` API (أمان كامل مع WAL checkpoint)
2. أو: `PRAGMA wal_checkpoint(FULL)` → إغلاق الاتصال → copyFile → إعادة فتح الاتصال
3. في الإنتاج: استخدم `sqlite3-backup` أو أداة متخصصة

**المخاطر إذا لم تُصلح:** فساد قاعدة البيانات، فقدان البيانات، crash.

---

### 🟠 HIGH

---

#### H-001 — `validatePhone()` and `validateCoords()` Defined But Never Called

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملفات المتأثرة** | `src/utils/helpers.js`, `src/routes/auth.js` |
| **السبب** | دوال التحقق موجودة لكن لا أحد يستدعيها |

**المشكلة:**
```js
// helpers.js — موجودة لكن غير مستخدمة
function validatePhone(phone) { ... }
function validateCoords(lat, lng) { ... }

// auth.js — POST /login
const { phone, name } = req.body;
if (!phone) return res.status(400)...  // تحقق بدائي فقط
// لا validatePhone() — يقبل "abc", "<script>", "1", ...
```

**التأثير:** أرقام هواتف غير صالحة تدخل DB، إمكانية XSS عبر name field (رغم sanitizeBody إلا أنه يتجاهل الأنواع غير النصية).

**الإصلاح:**
```js
// auth.js POST /login
if (!validatePhone(phone))
  return res.status(400).json({ success: false, message: 'رقم الهاتف غير صالح' });

// taxi.js POST /taxi/request
if (pickupLat && !validateCoords(pickupLat, pickupLng))
  return res.status(400).json({ success: false, message: 'إحداثيات غير صالحة' });
```

---

#### H-002 — `execSync('df -k .')` Blocks Node.js Event Loop

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملف المتأثر** | `src/routes/admin.js` — GET /admin/system |
| **السبب** | `child_process.execSync` يُجمّد event loop أثناء تنفيذ الأمر |

**المشكلة:**
```js
// admin.js
const out = execSync('df -k .', { encoding: 'utf8' })...  // ← يجمّد العملية بالكامل
```

**التأثير:** كل طلب لـ `/admin/system` يُجمّد معالجة **جميع** الطلبات الأخرى (Socket.IO، API calls) حتى ينتهي `df`.

**الإصلاح:**
```js
// استخدم execFile أو اقرأ /proc/mounts
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync('df', ['-k', '.']);
```

---

#### H-003 — Wallet Deduction Race Condition (No Atomic Check)

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملفات المتأثرة** | `src/services/payment.js`, `src/repositories/WalletRepository.js` |
| **السبب** | getBalance → check → deductBalance ثلاث عمليات منفصلة |

**المشكلة:**
```js
// PaymentService
const row = await walletRepo.getBalance(phone);     // [1] read balance
if (row.balance < amount) return { success: false }; // [2] check
await walletRepo.deductBalance(phone, amount);        // [3] deduct
// ← بين [2] و[3] يستطيع طلب آخر الخصم أيضاً → رصيد سالب!
```

**الإصلاح:**
```sql
-- Conditional update — atomic
UPDATE users SET balance = balance - ?
WHERE phone = ? AND balance >= ?
-- تحقق من this.changes === 1
```

---

#### H-004 — `driverRepo.findByName()` — Names Are Not Unique

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملف المتأثر** | `src/routes/taxi.js` — POST /taxi/trips/:id/rate |
| **السبب** | البحث بالاسم للإشعارات، والأسماء ليست unique في DB |

**المشكلة:**
```js
// taxi.js — rate endpoint
if (trip.driver_name) {
  const driver = await driverRepo.findByName(trip.driver_name);
  // ← إذا وُجد سائقان باسم "محمد"، سيُرسل الإشعار للأول في الـ index!
  if (driver) await notifRepo.sendForTrip(driver.phone, ...);
}
```

**الإصلاح:**
```js
// استخدم driver_id المُخزَّن في الرحلة بدلاً من البحث بالاسم
if (trip.driver_id) {
  const driver = await driverRepo.findById(trip.driver_id);
  if (driver) await notifRepo.sendForTrip(driver.phone, ...);
}
```

---

#### H-005 — Auto-Create Driver Without Any Verification

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملف المتأثر** | `src/routes/auth.js` — POST /driver/login |
| **السبب** | أي رقم هاتف يستطيع تسجيل الدخول كسائق وقبول رحلات فوراً |

**المشكلة:**
```js
let driver = await driverRepo.findByPhone(phone);
if (!driver) {
  driver = await driverRepo.create(phone);  // ← ينشئ سائقاً لأي رقم بلا تحقق
}
```

سائق جديد يحصل على: حساب سائق كامل، القدرة على قبول رحلات وتحديد الأجرة وتحديث الحالة.

**الإصلاح:** في الحد الأدنى: `is_active = 0` للسائقين الجدد (يحتاجون موافقة admin قبل التفعيل). الأفضل: طلب وثائق + موافقة يدوية.

---

#### H-006 — Socket.IO CORS Set to `origin: '*'`

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P2 |
| **الملف المتأثر** | `server.js` |
| **السبب** | HTTP CORS مقيّد بـ localhost، لكن Socket.IO مفتوح للجميع |

**المشكلة:**
```js
// server.js
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },  // ← مفتوح للجميع!
});
// بينما HTTP:
// setup.js: origin: ['http://localhost:3000', ...]  ← مقيّد
```

**الإصلاح:**
```js
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
```

---

#### H-007 — `/admin/shutdown` Callable With Admin JWT Only — No Confirmation

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | HIGH |
| **الأولوية** | P3 |
| **الملف المتأثر** | `src/routes/admin.js` |
| **السبب** | `POST /admin/shutdown` يوقف الخادم فوراً بدون تأكيد |

**المشكلة:**
```js
router.post('/admin/shutdown', authenticateAdmin, (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(0), 1000);  // ← يوقف الخادم بدون تأكيد!
});
```

أي JWT مسرَّب لمدير يستطيع إيقاف الخادم في الإنتاج.

**الإصلاح:** احذف هذا الـ endpoint أو اطلب `{ confirm: 'SHUTDOWN' }` في الـ body، أو استخدم `SIGTERM` من خارج التطبيق.

---

### 🟡 MEDIUM

---

#### M-001 — In-Memory Rate Limiting (Not Distributed)

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/middleware/rateLimiter.js` |

Rate limiter مخزَّن في memory فقط. عند:
- إعادة تشغيل الخادم → يُصفَّر العداد (يُتجاوز حماية brute force)
- multi-instance deployment → كل instance لها عداد منفصل

**الإصلاح:** Redis + `rate-limiter-flexible` library في الإنتاج.

---

#### M-002 — `phoneLoginLimit: 100 req/min` Too Permissive

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/middleware/rateLimiter.js` |

100 طلب/دقيقة لنفس رقم الهاتف يُتيح brute force هجوم على OTP المستقبلي.

**الإصلاح:** حد أقصى 5-10 طلبات/دقيقة على login endpoints.

---

#### M-003 — SQL Template Literals in Analytics Service

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/services/analytics.js` |

```js
// analytics.js
dbGet(`SELECT ... FROM trips WHERE created_at >= datetime('now', '-${p} days')`);
// p = Math.max(1, Math.min(365, Number(period))) — آمن لكن ممارسة سيئة
```

`p` مُعقَّم بـ `Number()` فلا SQL injection فعلي، لكن نمط template literals في SQL خطير إذا أُعيد استخدامه بدون تعقيم.

**الإصلاح:** استخدم parameterized queries دائماً أو `?` placeholders مع `datetime('now', ? || ' days')`.

---

#### M-004 — `/health` Endpoint Exposes System Info Without Authentication

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/routes/health.js` |

```js
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime, memory: { used, total }, cache: cache.size, timers: tripTimers.size });
});
```

الـ cache size وعدد الـ timers يُمكن استخدامهما في fingerprinting الخادم.

**الإصلاح:** بيانات مبسّطة لـ unauthenticated health checks؛ البيانات الكاملة فقط لـ `/admin/health` المحمية.

---

#### M-005 — `/driver/stats` Loads 1000 Trips Into Memory

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/routes/drivers.js` — GET /driver/stats/:phone |

```js
const trips = await tripRepo.findByDriver(driver.id, driver.name, 1000);
// ثم: filtering/aggregation في JavaScript
```

**الإصلاح:** استخدم SQL aggregation:
```sql
SELECT COUNT(*) as total,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
  SUM(CASE WHEN status='completed' THEN final_fare ELSE 0 END) as total_earnings
FROM trips WHERE driver_id = ?
```

---

#### M-006 — `console.log/error` Still Used in backup.js and places.js

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملفات المتأثرة** | `src/services/backup.js`, `src/services/places.js` |

```js
// backup.js
console.log(`✅ Backup created: oncall_${timestamp}.db`);
console.error('Backup error:', err.message);

// places.js
console.warn('[PlacesService] GOOGLE_MAPS_API_KEY not set');
console.error('[PlacesService] autocomplete error:', err.message);
```

هذه الـ logs تتجاوز `logger` وتُفقد من ring buffer ومن `GET /admin/logs`.

**الإصلاح:** مرّر `logger` عبر DI إلى backup/places، أو استورد `logger` مباشرة.

---

#### M-007 — GET /taxi/trips/:id Has No Ownership Check

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/routes/taxi.js` — GET /taxi/trips/:id |

```js
router.get('/taxi/trips/:id', authenticate, async (req, res) => {
  const trip = await tripRepo.findById(Number(req.params.id));
  if (!trip) return res.status(404)...;
  res.json({ success: true, trip: formatTrip(trip) });
  // ← أي مستخدم مُسجَّل يستطيع رؤية تفاصيل أي رحلة بمعرّفها
});
```

`formatTrip` يُعيد `user_phone` وتفاصيل الرحلة الكاملة.

**الإصلاح:**
```js
const isPassenger = req.user.phone === trip.user_phone;
const requestingDriver = await driverRepo.findByPhone(req.user.phone);
const isDriver = requestingDriver && trip.driver_id === requestingDriver.id;
const isAdmin = req.user.role === 'admin';
if (!isPassenger && !isDriver && !isAdmin)
  return res.status(403).json({ success: false });
```

---

#### M-008 — Logger Ring Buffer Too Small (200 Entries)

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/utils/logger.js` |

تحت load عالية (مثلاً: 200+ طلب متزامن)، يُعاد استخدام الـ buffer بسرعة ويُفقد سجل الأخطاء.

**الإصلاح:** زيادة إلى 1000+ مع في نفس الوقت إضافة file-based logging (log rotation بـ `winston` أو `pino`).

---

#### M-009 — No Explicit Request Body Size Limit

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملف المتأثر** | `src/middleware/setup.js` |

الحد الافتراضي لـ Express هو 100kb للـ JSON. لا يوجد `limit` صريح، مما يعني أن ملفات كبيرة أو payloads ضخمة ستصل إلى المعالج.

**الإصلاح:**
```js
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
```

---

#### M-010 — No JWT Refresh Token or Token Revocation

| الحقل | التفاصيل |
|-------|---------|
| **التصنيف** | MEDIUM |
| **الملفات المتأثرة** | `src/middleware/auth.js`, `src/routes/auth.js` |

- Token مدته 24 ساعة بلا آلية revocation
- `POST /logout` لا يُبطل الـ token فعلياً (فقط يُسجّل في log)
- إذا سُرق token، يبقى صالحاً 24 ساعة بدون طريقة لإلغائه

**الإصلاح:** token blacklist مؤقتة (Redis) أو تقليل مدة الـ token لـ 1-2 ساعة مع refresh token.

---

### 🔵 LOW

---

#### L-001 — `wallets` Table Created But Never Used

`wallets` table موجودة في schema لكن `WalletRepository` يعمل على `users.balance`. الجدول مهمل.

**الإصلاح:** احذف جدول `wallets` أو استخدمه كبديل صحيح لـ `users.balance`.

---

#### L-002 — `login_logs` Table Created But Never Populated

جدول `login_logs` يُنشأ في `database.js` لكن لا يوجد `INSERT` في أي مكان في الكود.

**الإصلاح:** سجّل عمليات login/logout فيه لأغراض الأمن والتدقيق، أو احذفه.

---

#### L-003 — Multiple Dead DB Columns

الأعمدة التالية موجودة في DB لكن لا تُحدَّث أبداً:
- `drivers.total_trips`, `total_earnings`, `acceptance_rate` — تظل 0
- `drivers.car_model`, `car_year`, `color` — تظل فارغة
- `users.total_trips`, `total_spent` — تظل 0
- `trips.user_id` — لا يُملأ (يُستخدم `user_phone` فقط)

**الإصلاح:** إما احذفها من الـ schema أو ابدأ بملئها بـ UPDATE بعد كل رحلة.

---

#### L-004 — Duplicate Migration Code in `database.js` and `src/config/migrate.js`

الـ ALTER TABLE migrations موجودة في مكانين:
1. `database.js` (root) — inline في نهاية الملف
2. `src/config/migrate.js` — منفصل

مما يُنفَّذ مرتين عند كل تشغيل (مُؤمَّن بـ "duplicate column" check، لكن مُربك).

**الإصلاح:** ضع كل migrations في `src/config/migrate.js` فقط واحذفها من `database.js`.

---

#### L-005 — `safeJSON` Implementation Slightly Inefficient

```js
// helpers.js
function safeJSON(str, fallback = []) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));  // ← يُسلسل ثم يُفكك الـ fallback
  } catch {
    return fallback;
  }
}
```

**الإصلاح:**
```js
function safeJSON(str, fallback = []) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
```

---

#### L-006 — CPU% Metric Can Exceed 100% on Multi-Core Systems

```js
// metrics.js
_cpuPercent = Math.round(((usage.user + usage.system) / elapsed) * 100 * 10) / 10;
```

`process.cpuUsage()` يُعيد microseconds مجمَّعة عبر جميع الـ cores، مما يُعطي قيمة > 100% على أجهزة متعددة الـ core.

**الإصلاح:** اقسم على `os.cpus().length`.

---

#### L-007 — `ADMIN_PHONES=112,99999999` Test Numbers in `.env`

أرقام التطوير موجودة في ملف `.env` الحقيقي. إذا وصل هذا الملف لأي شخص، يعرف أرقام المديرين.

---

#### L-008 — `db.serialize()` Scope Issue in `database.js`

جداول `reports` و`scooter_rides` تُنشأ خارج `db.serialize()` مما يعني أنها قد تنفَّذ بالتوازي مع الـ migrations في صف الانتظار.

---

## Prioritized Implementation Plan

### Phase A — Immediate (قبل أي Deployment في الإنتاج)

| # | المشكلة | الوقت المتوقع | الملفات |
|---|---------|--------------|---------|
| A1 | C-001: إعادة توليد secrets + `.gitignore` | 30 دقيقة | `.env`, `.gitignore` |
| A2 | C-002: حذف `req.query.token` | 5 دقائق | `src/middleware/auth.js` |
| A3 | C-004: Atomic unlock للسكوتر | 2 ساعة | `src/routes/scooters.js`, `src/repositories/ScooterRepository.js` |
| A4 | C-005: Atomic trip acceptance | 1 ساعة | `src/routes/taxi.js`, `src/repositories/TripRepository.js` |
| A5 | C-006: إصلاح `/admin/db/restore` | 2 ساعة | `src/routes/admin.js` |
| A6 | H-006: تقييد CORS لـ Socket.IO | 15 دقيقة | `server.js` |

**إجمالي الوقت: ~6 ساعات**

---

### Phase B — Before First Users (قبل أي مستخدمين حقيقيين)

| # | المشكلة | الوقت المتوقع | الملفات |
|---|---------|--------------|---------|
| B1 | C-003: منع auto-create بدون OTP (أو حذف الـ 10 KD) | 1 يوم | `src/routes/auth.js`, `UserRepository.js` |
| B2 | H-003: Atomic wallet deduction | 2 ساعات | `src/repositories/WalletRepository.js`, `src/services/payment.js` |
| B3 | H-004: استخدام `driver_id` بدل `driver_name` في rate | 30 دقيقة | `src/routes/taxi.js` |
| B4 | H-005: `is_active=0` للسائقين الجدد | 30 دقيقة | `src/routes/auth.js`, `src/repositories/DriverRepository.js` |
| B5 | H-001: استدعاء `validatePhone()` في auth routes | 1 ساعة | `src/routes/auth.js`, `src/routes/drivers.js` |
| B6 | H-002: `execFile` بدل `execSync` | 30 دقيقة | `src/routes/admin.js` |
| B7 | H-007: حذف أو تأمين `/admin/shutdown` | 15 دقيقة | `src/routes/admin.js` |

**إجمالي الوقت: ~2 أيام**

---

### Phase C — Production Hardening

| # | المشكلة | الوقت المتوقع |
|---|---------|--------------|
| C1 | M-007: Ownership check على GET /taxi/trips/:id | 1 ساعة |
| C2 | M-001: Redis rate limiting | 1 يوم |
| C3 | M-002: تقليل phoneLoginLimit إلى 5/min | 5 دقائق |
| C4 | M-010: Token blacklist أو قصر المدة | 2 ساعات |
| C5 | M-005: SQL aggregation في /driver/stats | 1 ساعة |
| C6 | M-006: إضافة logger لـ backup.js وplaces.js | 30 دقيقة |
| C7 | M-009: body size limit صريح | 10 دقائق |
| C8 | M-004: parameterized queries في analytics | 2 ساعات |
| C9 | M-008: زيادة ring buffer + إضافة file rotation | 1 ساعة |

**إجمالي الوقت: ~2 أيام**

---

### Phase D — Technical Debt Cleanup

| # | المشكلة | الوقت المتوقع |
|---|---------|--------------|
| D1 | L-001/L-002: حذف/استخدام wallets وlogin_logs | 2 ساعات |
| D2 | L-003: توحيد dead columns | 2 ساعات |
| D3 | L-004: دمج migration code | 1 ساعة |
| D4 | L-006: إصلاح CPU% metric | 15 دقيقة |
| D5 | L-005: تحسين safeJSON | 10 دقائق |
| D6 | M-004: تبسيط /health | 30 دقيقة |

**إجمالي الوقت: ~1 يوم**

---

## Future Improvement Suggestions

### قصيرة المدى (1-3 أشهر)
1. **OTP Verification** — تحقق برقم الهاتف عبر SMS قبل إنشاء أي حساب
2. **Refresh Tokens** — token صغير (15 دقيقة) + refresh token (30 يوم) مخزَّن بأمان
3. **Driver Approval Flow** — سائق جديد يبدأ بـ `is_active=0`، مدير يوافق من dashboard
4. **PostgreSQL Migration** — SQLite ممتاز للتطوير، لكن PostgreSQL ضروري للإنتاج (concurrent writes، row-level locking، horizontal scaling)
5. **PM2 أو Docker** — بدلاً من `node server.js` مباشرة

### متوسطة المدى (3-6 أشهر)
6. **Redis Caching** — بديل in-memory cache للـ multi-instance deployment
7. **Push Notifications** — Firebase FCM بدلاً من notifications table فقط
8. **Unit Tests for Services/Repositories** — الاختبارات الحالية integration-only
9. **Payment Gateway Integration** — K-Net / MyFatoorah بدلاً من placeholder
10. **Admin Dashboard Frontend** — واجهة ويب للـ admin بدلاً من raw API calls

### طويلة المدى (6-12 شهر)
11. **Microservices** — فصل Trips، Payments، Notifications كـ services مستقلة
12. **WebSocket Clustering** — Socket.IO adapter (Redis/MongoDB) للـ multi-server
13. **Audit Log** — سجل تدقيق كامل لكل تغيير في البيانات الحساسة
14. **GDPR/Privacy** — آلية حذف بيانات المستخدم، data retention policy
15. **Load Testing** — k6 أو Artillery لتحديد حدود الطاقة قبل الإطلاق

---

## Summary Table — All Issues

| ID | التصنيف | الوصف | الملف الرئيسي | الوقت |
|----|---------|--------|--------------|-------|
| C-001 | 🔴 CRITICAL | Real secrets in .env | `.env` | 30 دق |
| C-002 | 🔴 CRITICAL | JWT token in URL query param | `auth.js` middleware | 5 دق |
| C-003 | 🔴 CRITICAL | No phone verification — auto-create + free balance | `routes/auth.js` | 1 يوم |
| C-004 | 🔴 CRITICAL | TOCTOU race in scooter unlock | `routes/scooters.js` | 2 س |
| C-005 | 🔴 CRITICAL | TOCTOU race in trip acceptance | `routes/taxi.js` | 1 س |
| C-006 | 🔴 CRITICAL | /admin/db/restore corrupts live DB | `routes/admin.js` | 2 س |
| H-001 | 🟠 HIGH | validatePhone/validateCoords never called | `routes/auth.js` | 1 س |
| H-002 | 🟠 HIGH | execSync blocks event loop in /admin/system | `routes/admin.js` | 30 دق |
| H-003 | 🟠 HIGH | Wallet overdraft race condition | `WalletRepository.js` | 2 س |
| H-004 | 🟠 HIGH | findByName not unique — wrong driver notified | `routes/taxi.js` | 30 دق |
| H-005 | 🟠 HIGH | Auto-create driver with no verification | `routes/auth.js` | 30 دق |
| H-006 | 🟠 HIGH | Socket.IO CORS = `*` vs HTTP CORS = localhost | `server.js` | 15 دق |
| H-007 | 🟠 HIGH | /admin/shutdown callable with admin JWT only | `routes/admin.js` | 15 دق |
| M-001 | 🟡 MEDIUM | In-memory rate limiting — not distributed | `rateLimiter.js` | 1 يوم |
| M-002 | 🟡 MEDIUM | phoneLoginLimit = 100/min too permissive | `rateLimiter.js` | 5 دق |
| M-003 | 🟡 MEDIUM | SQL template literals in analytics | `services/analytics.js` | 2 س |
| M-004 | 🟡 MEDIUM | /health exposes system info unauthenticated | `routes/health.js` | 30 دق |
| M-005 | 🟡 MEDIUM | /driver/stats loads 1000 trips into memory | `routes/drivers.js` | 1 س |
| M-006 | 🟡 MEDIUM | console.log in backup.js and places.js | `services/backup.js`, `places.js` | 30 دق |
| M-007 | 🟡 MEDIUM | No ownership check on GET /taxi/trips/:id | `routes/taxi.js` | 1 س |
| M-008 | 🟡 MEDIUM | Logger ring buffer only 200 entries | `utils/logger.js` | 1 س |
| M-009 | 🟡 MEDIUM | No explicit request body size limit | `middleware/setup.js` | 10 دق |
| M-010 | 🟡 MEDIUM | No JWT refresh / revocation mechanism | `middleware/auth.js` | 2 س |
| L-001 | 🔵 LOW | `wallets` table unused | `database.js` | 2 س |
| L-002 | 🔵 LOW | `login_logs` table never populated | `database.js` | 2 س |
| L-003 | 🔵 LOW | Multiple dead DB columns | `database.js` | 2 س |
| L-004 | 🔵 LOW | Duplicate migration code | `database.js`, `migrate.js` | 1 س |
| L-005 | 🔵 LOW | safeJSON inefficiency | `utils/helpers.js` | 10 دق |
| L-006 | 🔵 LOW | CPU% > 100% on multi-core | `middleware/metrics.js` | 15 دق |
| L-007 | 🔵 LOW | Test phone numbers in .env | `.env` | 5 دق |
| L-008 | 🔵 LOW | db.serialize() scope issue in database.js | `database.js` | 30 دق |

---

**Total Issues: 31**  
- 🔴 Critical: 6  
- 🟠 High: 7  
- 🟡 Medium: 10  
- 🔵 Low: 8

---

*تقرير صادر عن: Full Engineering Audit — OnCall Backend v1.0.0*  
*التاريخ: 2026-07-01 | المرحلة: Read-Only — بانتظار الموافقة على الإصلاحات*
