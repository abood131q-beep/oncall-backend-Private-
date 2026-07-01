# OnCall API Reference

> **Base URL:** `http://localhost:3000`
> **Authentication:** Bearer Token — `Authorization: Bearer <token>` أو `x-session-token: <token>`
> **Content-Type:** `application/json`

---

## المصادقة (Auth)

### POST `/login`
تسجيل دخول الراكب. ينشئ حساباً جديداً تلقائياً إذا لم يكن موجوداً.

**Rate Limit:** 10 طلبات/دقيقة (IP) + 5 طلبات/دقيقة (هاتف)

| الحقل | النوع | مطلوب | الوصف |
|-------|-------|--------|-------|
| `phone` | string | ✅ | رقم الهاتف |
| `name` | string | ❌ | اسم المستخدم (افتراضي: "راكب") |

```json
// Response 200
{
  "success": true,
  "user": { "id": 1, "phone": "965XXXXXXX", "name": "أحمد", "balance": 10 },
  "token": "eyJ..."
}
```

---

### POST `/driver/login`
تسجيل دخول السائق. ينشئ حساباً جديداً تلقائياً. يُعيد السائق إلى وضع offline عند الدخول.

**Rate Limit:** نفس `/login`

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `phone` | string | ✅ |

```json
// Response 200
{
  "success": true,
  "driver": { "id": 1, "phone": "965XXXXXXX", "name": "سائق جديد", "status": "offline" },
  "token": "eyJ..."
}
```

---

### POST `/logout`
تسجيل الخروج (يُسجّل الحدث فقط، الـ JWT لا تُلغى من السيرفر).

**Headers:** `Authorization: Bearer <token>`

```json
{ "success": true, "message": "تم تسجيل الخروج" }
```

---

### GET `/auth/verify`
التحقق من صلاحية الجلسة.

**Headers:** `x-session-token: <token>`

```json
// Response 200
{ "success": true, "session": { "phone": "965XXXXXXX", "type": "passenger" } }
// Response 401
{ "success": false, "message": "الجلسة منتهية" }
```

---

## المستخدمون (Users)

### POST `/user/update` 🔒
تحديث اسم المستخدم.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `name` | string | ✅ |

---

### GET `/balance/:phone` 🔒
الحصول على رصيد المحفظة.

```json
{ "success": true, "balance": 10.500 }
```

---

### POST `/balance/add` 🔒
إضافة رصيد يدوياً (للاختبار).

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `amount` | number | ✅ |

---

### GET `/transactions/:phone` 🔒
آخر 50 عملية مالية للمستخدم.

---

### GET `/notifications/:phone` 🔒
آخر 20 إشعار للمستخدم.

---

### PUT `/notifications/:phone/read` 🔒
تعيين جميع الإشعارات كمقروءة.

---

### POST `/report` 🔒
إرسال بلاغ.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `phone` | string | ✅ |
| `type` | string | ❌ | (افتراضي: "general") |
| `description` | string | ✅ |
| `trip_id` | number | ❌ |

---

## السائقون (Drivers)

### POST `/driver/status` 🔒
تحديث حالة السائق (online/offline). يُحدّث حالة التاكسي المرتبط تلقائياً.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `phone` | string | ✅ |
| `isOnline` | boolean | ✅ |

---

### GET `/driver/info/:phone` 🔒
بيانات السائق الكاملة.

---

### POST `/driver/update` 🔒
تحديث بيانات السائق.

| الحقل | النوع |
|-------|-------|
| `phone` | string |
| `name` | string |
| `car_name` | string |
| `plate` | string |

---

### GET `/driver/trips/:phone` 🔒
آخر 100 رحلة للسائق.

---

### GET `/driver/stats/:phone` 🔒
إحصائيات السائق الشاملة.

```json
{
  "success": true,
  "stats": {
    "totalTrips": 45,
    "completedTrips": 38,
    "cancelledTrips": 4,
    "totalEarnings": 92.350,
    "todayEarnings": 12.100,
    "weekEarnings": 55.500,
    "totalHours": 18.5,
    "acceptanceRate": 91,
    "avgRating": 4.8
  }
}
```

---

### GET `/driver/reviews/:phone` 🔒
تقييمات الركاب للسائق (آخر 20).

---

## السكوترات (Scooters)

### GET `/scooters`
قائمة جميع السكوترات (مع Cache 10 ثوانٍ).

### GET `/scooters/:id`
بيانات سكوتر محدد.

### POST `/scooter/unlock` 🔒
فتح قفل سكوتر وبدء الرحلة.

**الشروط:**
- السكوتر بحالة `available`
- رصيد المستخدم ≥ 0.500 KD
- بطارية السكوتر > 10%

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `scooterId` | number | ✅ |
| `phone` | string | ✅ |

```json
{
  "success": true,
  "rideId": 12,
  "startTime": 1720000000000
}
```

### POST `/scooter/end-ride` 🔒
إنهاء رحلة السكوتر وحساب الأجرة.

**الأجرة:** `max(0.500, minutes × 0.050)` KD

| الحقل | النوع |
|-------|-------|
| `scooterId` | number |
| `phone` | string |
| `endLat` | number |
| `endLng` | number |

### GET `/scooter/history/:phone` 🔒
آخر 20 رحلة للمستخدم.

### GET `/scooter/active/:phone` 🔒
الرحلة الجارية حالياً للمستخدم (إن وجدت).

### POST `/admin/scooters` 🔐
إضافة سكوتر جديد.

### DELETE `/admin/scooters/:id` 🔐
حذف سكوتر.

### POST `/scooters/reset` 🔐
إعادة تعيين حالة جميع السكوترات والتاكسيات.

---

## التاكسي (Taxi)

### GET `/taxis`
قائمة جميع التاكسيات المتاحة.

### POST `/taxi/request` 🔒
طلب رحلة تاكسي جديدة.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `phone` | string | ✅ |
| `pickup` | string | ✅ | اسم موقع الانطلاق |
| `destination` | string | ✅ | اسم الوجهة |
| `pickupLat` | number | ✅ |
| `pickupLng` | number | ✅ |
| `destLat` | number | ✅ |
| `destLng` | number | ✅ |
| `paymentMethod` | string | ❌ | (افتراضي: "cash") |

```json
{
  "success": true,
  "trip": {
    "id": 23,
    "status": "waiting_driver",
    "estimatedFare": 5.371,
    "distanceKm": 12.55
  }
}
```

### GET `/taxi/trips` 
آخر 50 رحلة (عامة).

### GET `/taxi/requests`
طلبات التاكسي بحالة `waiting_driver`.

### GET `/taxi/trips/passenger/:phone` 🔒
رحلات راكب محدد.

### GET `/taxi/trips/:id` 
بيانات رحلة محددة.

### GET `/taxi/trips/:id/location`
موقع التاكسي الحالي لرحلة معينة.

### PUT `/taxi/trips/:id/status` 🔒
تحديث حالة الرحلة من قِبل السائق.

| الحالة | المعنى |
|--------|--------|
| `accepted` | السائق قبل الرحلة |
| `arrived` | السائق وصل لموقع الراكب |
| `in_progress` | الرحلة بدأت |
| `completed` | الرحلة اكتملت |
| `cancelled` | تم الإلغاء |

### POST `/taxi/trips/:id/reject` 🔒
رفض الرحلة من قِبل السائق (يُحوّلها لأقرب سائق آخر).

### POST `/taxi/trips/:id/rate` 🔒
تقييم السائق من قِبل الراكب (1-5 نجوم).

### POST `/taxi/trips/:id/rate-passenger` 🔒
تقييم الراكب من قِبل السائق.

### POST `/taxi/update-location`
تحديث موقع السائق (Socket.IO بديل بسيط عبر HTTP).

### DELETE `/taxi/trips` 🔐
حذف جميع الرحلات (Admin فقط).

---

## الدفع والمحفظة (Payment)

### GET `/payment/methods`
قائمة طرق الدفع المتاحة.

```json
{
  "methods": [
    { "id": "cash",   "name": "نقداً",    "icon": "💵", "available": true },
    { "id": "wallet", "name": "المحفظة",  "icon": "👛", "available": true },
    { "id": "knet",   "name": "كي نت",    "icon": "💳", "available": false, "note": "قريباً" }
  ]
}
```

### POST `/wallet/charge` 🔒
شحن المحفظة.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `amount` | number | ✅ |
| `method` | string | ❌ |

### GET `/wallet/transactions/:phone` 🔒
آخر 50 عملية مع الرصيد الحالي.

### GET `/wallet/balance/:phone` 🔒
الرصيد الحالي.

### POST `/fare/estimate`
تقدير أجرة رحلة.

| الحقل | النوع | مطلوب |
|-------|-------|--------|
| `pickupLat` | number | ✅ |
| `pickupLng` | number | ✅ |
| `destLat` | number | ✅ |
| `destLng` | number | ✅ |

```json
{
  "success": true,
  "distanceKm": 12.55,
  "estimatedMinutes": 38,
  "fare": 5.371,
  "multiplier": 1.5,
  "priceType": "ذروة"
}
```

### GET `/fare/config`
إعدادات الأجرة الحالية مع المضاعف.

```json
{
  "baseFare": 0.500,
  "perKm": 0.200,
  "perMinute": 0.015,
  "minimumFare": 0.750,
  "currentMultiplier": 1.5,
  "currentPriceType": "ذروة",
  "isPeakHour": true
}
```

---

## Google Places

### GET `/places/autocomplete`
اقتراحات الأماكن (يتطلب `GOOGLE_MAPS_API_KEY`).

**Query Params:** `input`, `lat`, `lng`

### GET `/places/details`
تفاصيل مكان محدد.

**Query Params:** `place_id`

---

## الصحة والنظام (Health)

### GET `/`
فحص بسيط — يُعيد نص "On Call Backend 🚀".

### GET `/test`
```json
{ "success": true, "message": "API Works" }
```

### GET `/health`
```json
{
  "status": "ok",
  "uptime": 3600,
  "memory": { "used": "45MB", "total": "120MB" },
  "cache": 3,
  "timers": 0,
  "timestamp": "2026-06-29T12:00:00.000Z"
}
```

---

## الإدارة (Admin) 🔐

جميع نقاط النهاية تتطلب `authenticateAdmin`.

| المسار | الوصف |
|--------|-------|
| `GET /admin/stats` | إحصائيات عامة + يومية + أسبوعية |
| `GET /admin/trips` | جميع الرحلات (pagination: `?page=1&limit=50&status=...`) |
| `PUT /admin/trips/:id/cancel` | إلغاء رحلة |
| `GET /admin/drivers` | جميع السائقين |
| `GET /admin/users` | جميع المستخدمين |
| `PUT /admin/users/:phone/toggle` | تفعيل/تعطيل مستخدم |
| `PUT /admin/drivers/:phone/toggle` | تفعيل/تعطيل سائق |
| `POST /admin/taxis` | إضافة تاكسي |
| `DELETE /admin/taxis/:id` | حذف تاكسي |
| `GET /admin/reports` | آخر 100 بلاغ |
| `PUT /admin/reports/:id/resolve` | تعيين البلاغ كمحلول |
| `GET /admin/revenue` | الإيرادات اليومية (30 يوم) |
| `GET /admin/analytics` | تحليلات متقدمة (`?period=30`) |
| `GET /admin/backups` | قائمة النسخ الاحتياطية |
| `POST /admin/backup` | إنشاء نسخة احتياطية |
| `GET /admin/dashboard` | لوحة تشخيص شاملة |

---

## رموز الخطأ

| الكود | المعنى |
|-------|--------|
| 400 | بيانات غير صحيحة |
| 401 | غير مصرح — token مفقود أو منتهي |
| 403 | محظور — لا صلاحية |
| 404 | المورد غير موجود |
| 429 | تجاوز Rate Limit |
| 500 | خطأ داخلي في السيرفر |

---

## الرموز

- 🔒 يتطلب `authenticate` (أي مستخدم مسجل)
- 🔐 يتطلب `authenticateAdmin` (admin فقط)
