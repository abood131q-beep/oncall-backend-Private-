# P6-06 — Driver Approval Workflow: Design Document

**المشروع:** OnCall Backend  
**التاريخ:** 2026-07-16  
**المُعِد:** CTO + Principal Software Engineer  
**الحالة:** مسودة — بانتظار الموافقة قبل التنفيذ  
**الأولوية:** Critical — Security + Business Logic

---

## القسم الأول — التحليل: واقع النظام الحالي

### 1. كيف يصبح الشخص سائقاً؟

يُرسل طلب `POST /driver/login` بأي رقم هاتف. النظام في `auth.js`:

```js
let driver = await driverRepo.findByPhone(phone);
if (!driver) {
  driver = await driverRepo.create(phone);   // ← ينشئه فوراً إذا لم يكن موجوداً
}
if (driver.is_active === 0) {
  return res.status(403).json({ message: 'حساب السائق موقوف — تواصل مع الدعم' });
}
// ← يُصدر JWT مباشرة
```

`DriverRepository.create()`:
```js
'INSERT INTO drivers (phone, name, car_name, status, is_active) VALUES (?, ?, ?, ?, ?)',
[phone, 'سائق جديد', '', 'offline', 0]
```

**ينشئ السائق بـ `is_active=0` → يُمنع من الدخول فوراً.**

### 2. هل يمكن لأي شخص إنشاء حساب سائق؟

**نعم.** `POST /driver/login` بأي رقم هاتف يُنشئ حساباً تلقائياً. لا يتطلب:
- موافقة مسبقة
- وثائق
- تحقق من الهوية

### 3. هل يصبح Active مباشرة؟

**لا** — `is_active=0` عند الإنشاء. لكن هذا مجرد 0/1 ثنائي لا يوضح السبب.

### 4. أين يتم تخزين حالة السائق؟

**جدول `drivers`** يحتوي على حقلَين للحالة:
- `status TEXT DEFAULT 'offline'` — الحالة التشغيلية (online/offline/busy)
- `is_active INTEGER DEFAULT 1` — (مُضاف عبر migrate.js) — مفتاح تشغيل/إيقاف ثنائي

لا يوجد حقل للحالة الإدارية: pending / approved / rejected / suspended.

### 5. كيف يتعامل النظام مع Driver Login؟

```
POST /driver/login
  → OTP verification (if REQUIRE_OTP=true)
  → findByPhone || create (is_active=0)
  → if is_active === 0 → 403 "حساب السائق موقوف"   ← رسالة واحدة للجميع
  → generateJWT + generateRefreshToken
  → Response: { success, driver, token, refreshToken }
```

**المشكلة:** رسالة "موقوف" تُستخدم لكل الحالات (pending/rejected/suspended) — المستخدم لا يعرف لماذا.

### 6. كيف يتم ربط السائق بالرحلات؟

```
دورة الرحلة:
1. taxi.js: POST /taxi/request → findNearestDriver()
2. driverMatcher.js: SELECT * FROM drivers WHERE status='online' AND taxi.status='online'
   ← لا يتحقق من is_active أو أي approval state!
3. Socket.io: driver:register → يضاف لـ 'drivers:online' room
   ← لا يتحقق من is_active أيضاً!
```

### 7. ⚠️ الثغرات الأمنية المكتشفة

**ثغرة A — Socket.IO (High):**
في `socket.js`، حدث `driver:register` لا يتحقق من `is_active`:
```js
socket.on('driver:register', async () => {
  if (socket.data.user.type !== 'driver') return;  // ← التحقق الوحيد
  socket.join('drivers:online');                    // ← لا فحص is_active!
  await dbRun("UPDATE drivers SET status='online' WHERE phone=?", ...);
```

**المخاطرة:** سائق يملك JWT صالحاً (أُصدر قبل التعليق) يمكنه الانضمام لـ `drivers:online` ويظهر في الـ matching.

**ثغرة B — Driver Matching (High):**
`findNearestDriver` في `driverMatcher.js`:
```js
WHERE d.status = 'online' AND t.status = 'online'
// ← لا يتحقق من is_active أو approval_status
```

**المخاطرة:** سائق غير معتمد قد يستقبل رحلات إذا تجاوز ثغرة A.

**ثغرة C — POST /driver/status (Medium):**
```js
router.post('/driver/status', authenticateDriver, async (req, res) => {
  // ← لا يتحقق من is_active أو approval_status قبل تغيير الحالة
  await driverRepo.setStatus(phone, status);
```

---

## القسم الثاني — التصميم

### State Machine للسائق

```
                    ┌──────────────────────────────────────┐
                    │         NEW DRIVER REGISTRATION       │
                    └──────────────────┬───────────────────┘
                                       │ POST /driver/login
                                       ▼
                              ┌─────────────────┐
                              │     PENDING      │ ← الحالة الافتراضية
                              │  (قيد المراجعة) │
                              └────────┬────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
           ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
           │   APPROVED   │   │   REJECTED   │  │  SUSPENDED   │
           │  (معتمد ✅)  │   │  (مرفوض ❌)  │  │  (موقوف ⛔)  │
           └──────┬───────┘   └──────────────┘  └──────┬───────┘
                  │                                      │
                  │◄─────────────────────────────────────┘
                  │         REACTIVATE (إعادة تفعيل)
                  │
                  ▼
           ┌──────────────┐
           │  SUSPENDED   │ ← يمكن التعليق من APPROVED
           └──────────────┘
```

### تعريف الحالات

| الحالة | المعنى | تسجيل الدخول | الظهور في Matching | تغيير الحالة إلى Online |
|--------|--------|:---:|:---:|:---:|
| `pending` | تسجيل جديد — بانتظار مراجعة المشرف | ✅ (مع رسالة) | ❌ | ❌ |
| `approved` | معتمد — تشغيل كامل | ✅ | ✅ | ✅ |
| `rejected` | مرفوض — يرى السبب | ✅ (مع السبب) | ❌ | ❌ |
| `suspended` | موقوف — يرى السبب | ✅ (مع السبب) | ❌ | ❌ |

**ملاحظة تصميمية:** جميع الحالات تسمح بتسجيل الدخول — لكن النظام يعيد الحالة والسبب. هذا UX أفضل من رسالة خطأ عمياء. السائق يعرف وضعه ويتصل بالدعم.

---

## القسم الثالث — قواعد العمل

### سلوك كل حالة

**PENDING:**
- تسجيل الدخول: `200 OK` + `{ success: true, driver: {...}, status: 'pending', message: 'حسابك قيد المراجعة — سيتم إخطارك عند الاعتماد' }`
- `POST /driver/status`: `403` — "حسابك لم يتم اعتماده بعد"
- Socket `driver:register`: مرفوض — `driver:error: { message: 'حسابك قيد المراجعة' }`
- Driver Matching: محجوب — `WHERE approval_status = 'approved'`
- FCM Token: يُسجَّل — ليصل الإشعار عند الاعتماد

**APPROVED:**
- تسجيل الدخول: `200 OK` — كامل
- جميع العمليات: مسموحة
- Driver Matching: مشمول

**REJECTED:**
- تسجيل الدخول: `200 OK` + `{ success: true, driver: {...}, status: 'rejected', reason: '...', message: 'تم رفض طلبك' }`
- `POST /driver/status`: `403`
- Socket `driver:register`: مرفوض
- Driver Matching: محجوب

**SUSPENDED:**
- تسجيل الدخول: `200 OK` + `{ success: true, driver: {...}, status: 'suspended', reason: '...', message: 'حسابك موقوف مؤقتاً' }`
- `POST /driver/status`: `403`
- Socket `driver:register`: مرفوض + Force disconnect
- Driver Matching: محجوب
- JWT النشط: يُلغى (revokeTokens) عند التعليق من المشرف

---

## القسم الرابع — قاعدة البيانات

### التحليل: هل نعيد استخدام is_active؟

**الوضع الحالي:** `is_active INTEGER DEFAULT 1` (via migrate.js)
- مُستخدَم في: auth.js، admin.js، DriverRepository، MCP tools
- القيمة: 0 = محظور، 1 = مفعّل

**القرار:** إبقاء `is_active` للتوافق مع الكود الحالي، وإضافة `approval_status` كالحقل الرئيسي للـ workflow. كلاهما يُحدَّث معاً.

| approval_status | is_active |
|----------------|-----------|
| pending | 0 |
| approved | 1 |
| rejected | 0 |
| suspended | 0 |

### الـ Migration المطلوب

**3 حقول جديدة فقط — لا حذف أي شيء:**

```sql
-- M1: حالة الاعتماد (القيمة الافتراضية pending للسائقين الجدد)
ALTER TABLE drivers ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';

-- M2: سبب الرفض أو التعليق (nullable)
ALTER TABLE drivers ADD COLUMN rejection_reason TEXT;

-- M3: من اعتمد/رفض/علّق السائق (phone المشرف)
ALTER TABLE drivers ADD COLUMN approved_by TEXT;
```

### Migration Script للبيانات الحالية

```sql
-- السائقون الموجودون الذين is_active=1 → approved (يعملون بالفعل)
UPDATE drivers SET approval_status = 'approved' WHERE is_active = 1;

-- السائقون الموجودون الذين is_active=0 → pending (لم يُفعَّلوا بعد)
-- نبقيهم pending لأننا لا نعرف سببهم الأصلي
UPDATE drivers SET approval_status = 'pending' WHERE is_active = 0;
```

---

## القسم الخامس — API

### Endpoints الجديدة

**1. قائمة السائقين المعلقين**
```
GET /admin/drivers/pending
Authorization: Bearer <admin_token>
Response 200: [ { id, phone, name, car_name, plate, created_at } ]
```

**2. اعتماد سائق**
```
PUT /admin/drivers/:phone/approve
Authorization: Bearer <admin_token>
Body: {} (لا body مطلوب)
Response 200: { success: true, driver: { ...driver, approval_status: 'approved' } }
Side effects:
  - approval_status = 'approved'
  - is_active = 1
  - approved_by = admin phone (من JWT)
  - FCM notification → السائق
  - Security log: DRIVER_APPROVED
```

**3. رفض سائق**
```
PUT /admin/drivers/:phone/reject
Authorization: Bearer <admin_token>
Body: { reason: "الوثائق غير مكتملة" }
Validation: reason مطلوب، 5-500 حرف
Response 200: { success: true, driver: { ...driver, approval_status: 'rejected' } }
Side effects:
  - approval_status = 'rejected'
  - rejection_reason = reason
  - is_active = 0
  - FCM notification → السائق
  - Security log: DRIVER_REJECTED
```

**4. تعليق سائق**
```
PUT /admin/drivers/:phone/suspend
Authorization: Bearer <admin_token>
Body: { reason: "مخالفة قواعد السلوك" }
Validation: reason مطلوب، 5-500 حرف
Response 200: { success: true, driver: { ...driver, approval_status: 'suspended' } }
Side effects:
  - approval_status = 'suspended'
  - rejection_reason = reason (نعيد استخدام نفس الحقل)
  - is_active = 0
  - status = 'offline'
  - revokeTokens(phone)                    ← إلغاء JWT الحالي
  - io.to(`driver:${phone}`).emit(...)     ← Force disconnect من Socket
  - FCM notification → السائق
  - Security log: DRIVER_SUSPENDED
```

**5. إعادة تفعيل سائق (approved → من rejected أو suspended)**
```
PUT /admin/drivers/:phone/reactivate
Authorization: Bearer <admin_token>
Body: {} (لا body مطلوب)
Response 200: { success: true, driver: { ...driver, approval_status: 'approved' } }
Side effects:
  - approval_status = 'approved'
  - rejection_reason = NULL
  - is_active = 1
  - FCM notification → السائق
  - Security log: DRIVER_REACTIVATED
```

### Endpoints المعدَّلة

**6. POST /driver/login (سلوك جديد)**
```
قبل: if (is_active === 0) → 403
بعد:
  if (approval_status === 'pending') → 200 + { status: 'pending', message: 'حسابك قيد المراجعة' }
  if (approval_status === 'rejected') → 200 + { status: 'rejected', reason, message: 'تم رفض طلبك' }
  if (approval_status === 'suspended') → 200 + { status: 'suspended', reason, message: 'حسابك موقوف' }
  if (approval_status === 'approved') → 200 + { token, refreshToken, driver } ← العمل الطبيعي
```

**ملاحظة:** نعيد 200 لكل الحالات لأن الطلب نجح تقنياً — لكن الـ payload يُوضح للـ Flutter ما يجب عرضه. السيرفر لا يُصدر JWT/refreshToken إلا لـ `approved` فقط.

**7. POST /driver/status (إضافة فحص)**
```
Authorization: Bearer <driver_token>
Body: { isOnline: bool }
إضافة: if (driver.approval_status !== 'approved') → 403
```

**8. GET /admin/drivers (إضافة approval_status في الرد)**
```
الرد الحالي: [ { id, phone, name, ..., is_active } ]
الرد الجديد: [ { id, phone, name, ..., is_active, approval_status, rejection_reason } ]
لا تغيير في الـ URL أو HTTP method — backward compatible
```

---

## القسم السادس — Socket.IO

### التعديلات المطلوبة

**driver:register (Security Fix — High):**
```js
// قبل
socket.on('driver:register', async () => {
  if (socket.data.user.type !== 'driver') return;
  socket.join('drivers:online');
  // ...
});

// بعد
socket.on('driver:register', async () => {
  if (socket.data.user.type !== 'driver') return;
  const phone = socket.data.user.phone;
  const driver = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [phone]);
  if (!driver || driver.approval_status !== 'approved') {
    socket.emit('driver:error', {
      code: 'NOT_APPROVED',
      message: 'حسابك لم يتم اعتماده بعد',
    });
    return;   // لا يدخل drivers:online
  }
  socket.join('drivers:online');
  // ... باقي الكود
});
```

**driver:status (Security Fix — Medium):**
```js
socket.on('driver:status', async (data) => {
  if (socket.data.user.type !== 'driver') return;
  const driver = await dbGet('SELECT approval_status FROM drivers WHERE phone = ?', [statusPhone]);
  if (!driver || driver.approval_status !== 'approved') return;
  // ... باقي الكود
});
```

---

## القسم السابع — Driver Matching

### التعديل في driverMatcher.js

```js
// قبل
WHERE d.status = 'online' AND t.status = 'online' ${exclusion}

// بعد
WHERE d.status = 'online' AND t.status = 'online'
  AND d.approval_status = 'approved'              ← إضافة واحدة فقط
  ${exclusion}
```

---

## القسم الثامن — Flutter

### الصفحات المتأثرة

**1. LoginPage (login_page.dart)**

السلوك الحالي:
```dart
if (result['success'] == true) {
  Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const DriverPage()));
}
```

السلوك الجديد:
```dart
if (result['success'] == true) {
  final driverStatus = result['status'];
  switch (driverStatus) {
    case 'pending':
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => const DriverPendingPage()));
      break;
    case 'rejected':
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => DriverRejectedPage(reason: result['reason'])));
      break;
    case 'suspended':
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => DriverSuspendedPage(reason: result['reason'])));
      break;
    default: // approved
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => const DriverPage()));
  }
}
```

**2. صفحة جديدة — DriverPendingPage**
```
الهدف: إخبار السائق بأن حسابه قيد المراجعة
المحتوى:
  - أيقونة ساعة
  - "حسابك قيد المراجعة"
  - "سيتم إخطارك عند اعتماد حسابك"
  - زر "تحقق من الحالة" (يعيد استدعاء /driver/login)
  - زر "تسجيل الخروج"
```

**3. صفحة جديدة — DriverRejectedPage**
```
المحتوى:
  - أيقونة رفض
  - "تم رفض طلبك"
  - سبب الرفض: [reason]
  - "يمكنك تقديم طلب جديد بعد مراجعة المتطلبات"
  - زر "تسجيل الخروج"
```

**4. صفحة جديدة — DriverSuspendedPage**
```
المحتوى:
  - أيقونة تحذير
  - "حسابك موقوف مؤقتاً"
  - سبب التعليق: [reason]
  - "تواصل مع الدعم لمزيد من المعلومات"
  - زر "تسجيل الخروج"
```

**5. DriverPage (driver_page.dart)**

إضافة فحص عند استقبال Socket `driver:error`:
```dart
SocketService.onDriverError((data) {
  if (data['code'] == 'NOT_APPROVED') {
    // تحويل لصفحة الانتظار
  }
});
```

**6. admin_dashboard.dart**

تعديلات على `_driversTab`:
- إضافة Badge "قيد المراجعة" للسائقين بـ `approval_status='pending'`
- قسم منفصل "السائقون الجدد" في أعلى القائمة
- زر Approve / Reject بدلاً من Toggle Switch فقط للـ pending
- Dialog لإدخال سبب الرفض/التعليق

---

## القسم التاسع — MCP

### أدوات MCP الجديدة (في drivers.ts)

**1. list_pending_drivers**
```
الوصف: List all drivers waiting for admin approval
الاستدعاء: GET /admin/drivers/pending
```

**2. approve_driver**
```
الوصف: Approve a pending driver and allow them to start working
المدخلات: phone (required)
الاستدعاء: PUT /admin/drivers/:phone/approve
```

**3. reject_driver**
```
الوصف: Reject a driver's application with a reason
المدخلات: phone (required), reason (required)
الاستدعاء: PUT /admin/drivers/:phone/reject
```

**4. suspend_driver**
```
الوصف: Suspend an approved driver temporarily with a reason
المدخلات: phone (required), reason (required)
الاستدعاء: PUT /admin/drivers/:phone/suspend
```

**5. reactivate_driver**
```
الوصف: Reactivate a rejected or suspended driver
المدخلات: phone (required)
الاستدعاء: PUT /admin/drivers/:phone/reactivate
```

---

## القسم العاشر — Security Review

### التحقق من عدم تجاوز الـ Approval

| المتجه | الحماية |
|-------|---------|
| Socket driver:register | `approval_status = 'approved'` check قبل join room |
| POST /driver/status | `approval_status = 'approved'` check قبل toggle |
| Driver Matching SQL | `AND d.approval_status = 'approved'` في الاستعلام |
| JWT بعد التعليق | `revokeTokens(phone)` فوري عند suspend |
| Socket active sessions | `io.to(driver:phone).emit('force_disconnect')` عند suspend |
| Admin approval endpoints | `authenticateAdmin` middleware على كل endpoint |
| Self-approval | المشرف فقط يملك الصلاحية — السائق لا يملك endpoint للـ approval |
| Approval by non-admin | `authenticateAdmin` middleware يمنع أي token آخر |

### تحليل Race Conditions

**سيناريو:** سائق معتمد يتلقى تعليقاً بينما هو في رحلة نشطة.

**الحل:**
1. عند `PUT /admin/drivers/:phone/suspend`:
   - تحديث قاعدة البيانات فوراً
   - `revokeTokens(phone)` — يُلغي الـ JWT الحالي
   - Socket force disconnect
   - الرحلة النشطة: **لا تُلغى تلقائياً** — المشرف يلغيها يدوياً إذا أراد
   - `approval_status` لا يمنع إكمال رحلة حُدِّدت مسبقاً (driver_id موجود في trips)

---

## القسم الحادي عشر — Implementation Plan

### Phase A — Database + Auth (Backend Core)

**الملفات:**
- `src/config/migrate.js` — إضافة 3 حقول
- `src/repositories/DriverRepository.js` — إضافة `findPending()`, `setApproval()`
- `src/routes/auth.js` — تعديل منطق login

**الاختبارات بعد A:**
- ESLint 0 errors
- node --check all files
- Unit tests 55/55

---

### Phase B — Admin Endpoints

**الملفات:**
- `src/routes/admin.js` — إضافة 5 endpoints

**الاختبارات بعد B:**
- ESLint 0 errors
- Unit tests 55/55
- يدوي: تجربة كل endpoint

---

### Phase C — Security Fixes (Socket + Matching)

**الملفات:**
- `src/socket.js` — إضافة approval_status check في driver:register
- `src/services/driverMatcher.js` — إضافة AND في SQL
- `src/routes/drivers.js` — إضافة approval check في POST /driver/status

**الاختبارات بعد C:**
- ESLint 0 errors
- Unit tests 55/55
- مراجعة أمنية

---

### Phase D — Flutter

**الملفات:**
- `oncall_app/lib/pages/login_page.dart`
- `oncall_app/lib/pages/driver_pending_page.dart` (جديد)
- `oncall_app/lib/pages/driver_rejected_page.dart` (جديد)
- `oncall_app/lib/pages/driver_suspended_page.dart` (جديد)
- `oncall_app/lib/admin_dashboard.dart`

**الاختبارات بعد D:**
- flutter analyze 0 errors
- فحص syntax

---

### Phase E — MCP

**الملفات:**
- `tools/oncall-mcp/src/tools/drivers.ts` — إضافة 5 أدوات

**الاختبارات بعد E:**
- MCP tsc build 0 errors
- يدوي: تجربة الأدوات

---

### Phase F — Regression + Certification

- ESLint 0 errors (كامل)
- Unit tests 55/55
- Syntax check كل الملفات
- MCP build
- كتابة P6-06 Certification Report

---

## ملخص التأثير

| المكوِّن | التغييرات |
|---------|----------|
| Database | 3 حقول جديدة (migration آمن) |
| DriverRepository | إضافة 2 method |
| auth.js | تعديل منطق login response |
| admin.js | إضافة 5 endpoints |
| socket.js | إضافة approval check |
| driverMatcher.js | إضافة AND في SQL واحدة |
| drivers.js | إضافة approval check |
| Flutter: login_page | تعديل routing بعد login |
| Flutter: 3 صفحات جديدة | pending / rejected / suspended |
| Flutter: admin_dashboard | إضافة pending section + approve/reject/suspend UI |
| MCP: drivers.ts | إضافة 5 أدوات |

**تقدير الملفات المعدَّلة:** 8 ملفات موجودة + 3 ملفات Flutter جديدة

**تقدير الأسطر المضافة:** ~300 سطر backend + ~200 سطر Flutter

**مخاطر الـ Regression:** منخفضة — التعديلات بالإضافة وليس التعديل، الـ API contract محافَظ عليه.

---

*وثيقة التصميم — بانتظار موافقة CTO للبدء بالتنفيذ*  
*لا يُبدأ أي تنفيذ قبل الموافقة الصريحة*
