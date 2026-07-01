# OnCall Services Reference

> جميع الـ Services موجودة في `src/services/`
> تتبع نمط **Factory Function** مع **Dependency Injection** عبر كائن `svc`.

---

## 1. BackupService — `src/services/backup.js`

**المسؤوليات:** إنشاء نسخ احتياطية لقاعدة البيانات والحفاظ على آخر 7 نسخ.

### الاستخدام

```js
const { createBackup, startBackupSchedule } = require('./src/services/backup');

startBackupSchedule(); // يبدأ تلقائياً عند تشغيل السيرفر
```

### الدوال

#### `createBackup(): Promise<void>`
ينسخ `oncall.db` إلى مجلد `backups/` باسم `oncall-YYYY-MM-DD-HH-MM-SS.db`.
يحتفظ بآخر 7 نسخ ويحذف الأقدم.

#### `startBackupSchedule(): void`
- نسخة فورية بعد 5 ثوانٍ من بدء التشغيل
- نسخة تلقائية كل 6 ساعات

### الإعدادات
```
مسار النسخ: ./backups/
أقصى عدد نسخ: 7
التأخير الأول: 5000ms
الفترة الدورية: 6 × 60 × 60 × 1000ms
```

---

## 2. CacheService — `src/services/cache.js`

**المسؤوليات:** Cache في الذاكرة مع TTL لتقليل استعلامات قاعدة البيانات.

### الاستخدام

```js
const { getCache, setCache, clearCache, CACHE_TTL, cache } = require('./src/services/cache');

// القراءة
const data = getCache('scooters');
if (data) return res.json(data);

// الكتابة
setCache('scooters', data, CACHE_TTL.scooters);

// المسح
clearCache('scooters');  // مسح مفتاح واحد
clearCache();            // مسح الكل
```

### الدوال

| الدالة | الوصف |
|--------|-------|
| `getCache(key)` | يُعيد القيمة أو `null` إذا انتهت صلاحيتها |
| `setCache(key, value, ttlMs)` | يحفظ القيمة مع وقت انتهاء |
| `clearCache(key?)` | يمسح مفتاحاً واحداً أو الكل |

### مدد الصلاحية (CACHE_TTL)

| المفتاح | المدة |
|---------|-------|
| `scooters` | 10,000ms (10 ثوانٍ) |
| `taxis` | 10,000ms |
| `stats` | 30,000ms (30 ثانية) |
| `trips` | 5,000ms (5 ثوانٍ) |

**تنظيف تلقائي:** كل 30 ثانية يُحذف المنتهي الصلاحية.

---

## 3. FareCalculatorService — `src/services/fareCalculator.js`

**المسؤوليات:** حساب الأجرة مع مضاعفات الذروة والليل، وتنسيق بيانات الرحلة.

### الاستخدام

```js
const {
  FARE_CONFIG, getPriceMultiplier,
  calculateFare, getFareBreakdown, formatTrip
} = require('./src/services/fareCalculator');
```

### الإعدادات (FARE_CONFIG)

```js
{
  baseFare:    0.500,  // الأجرة الأساسية (KD)
  perKm:       0.200,  // السعر لكل كيلومتر
  perMinute:   0.015,  // السعر لكل دقيقة
  minimumFare: 0.750,  // الحد الأدنى
}
```

### المضاعفات

| الوقت | المضاعف | التسمية |
|-------|---------|---------|
| 7:00–9:00 صباحاً | 1.5× | ذروة |
| 16:00–19:00 مساءً | 1.5× | ذروة |
| 23:00–5:00 فجراً | 1.25× | ليلي |
| باقي الأوقات | 1.0× | عادي |

### الدوال

#### `getPriceMultiplier(): { multiplier, label }`
يُعيد المضاعف الحالي حسب الوقت.

#### `calculateFare(distanceKm, durationMinutes): number`
```
fare = baseFare + (distanceKm × perKm) + (durationMinutes × perMinute)
fare = max(minimumFare, fare × multiplier)
```

#### `getFareBreakdown(distanceKm, durationMinutes): object`
يُعيد تفاصيل الأجرة شاملة الكسر والمضاعف.

#### `formatTrip(trip): object`
يُحوّل حقول snake_case من قاعدة البيانات إلى camelCase لـ API:

```
trip_id        → tripId
user_phone     → userPhone
pickup_lat     → pickupLat
dest_lat       → destLat
final_fare     → finalFare
driver_name    → driverName
created_at     → createdAt
...
```

---

## 4. DriverMatcherService — `src/services/driverMatcher.js`

**المسؤوليات:** إيجاد أقرب سائق متاح وإرسال طلب الرحلة مع نظام timeout للتصعيد التلقائي.

### الاستخدام

```js
const { createDriverMatcher, DRIVER_TIMEOUT } = require('./src/services/driverMatcher');

// داخل route factory
const { findNearestDriver, sendRequestToDriver } = createDriverMatcher(svc);
```

### الثوابت

```js
DRIVER_TIMEOUT = 30000  // 30 ثانية قبل التصعيد لسائق آخر
```

### الدوال

#### `findNearestDriver(pickupLat, pickupLng, excludeDriverIds?): Promise<driver|null>`
- يجلب السائقين المتاحين (`status='online'`) بـ parameterized queries (آمن من SQL Injection)
- يحسب المسافة بـ Haversine Formula
- يُعيد أقرب سائق أو `null` إذا لا يوجد

#### `sendRequestToDriver(tripId, driver): Promise<void>`
1. يُعيّن الرحلة للسائق في قاعدة البيانات
2. يُرسل حدث Socket.IO `trip:request` للسائق
3. يبدأ timer (30 ثانية):
   - إذا لم يرد السائق → يستدعي `findNearestDriver` مع استبعاده
   - إذا وجد سائق آخر → `sendRequestToDriver` للسائق الجديد
   - إذا لا يوجد → يُحدّث الرحلة لـ `no_driver_found`

### تدفق الطلب

```
POST /taxi/request
  ↓
findNearestDriver(pickup)
  ↓
sendRequestToDriver(trip, driver)
  ↓ [30s timeout]
driver رفض/لم يرد؟
  → findNearestDriver(pickup, excludeIds=[driver.id])
  → sendRequestToDriver(trip, nextDriver) | status='no_driver_found'
```

---

## 5. PaymentService — `src/services/payment.js`

**المسؤوليات:** معالجة دفع أجرة الرحلة عبر المحفظة أو نقداً مع تسجيل العملية.

### الاستخدام

```js
const { createPaymentService } = require('./src/services/payment');

// داخل route factory
const { processPayment } = createPaymentService(svc);

const result = await processPayment(tripId, phone, amount, method);
```

### `processPayment(tripId, phone, amount, method): Promise<object>`

#### طريقة `wallet`
1. يتحقق من كفاية الرصيد
2. يخصم المبلغ من `users.balance`
3. يُسجّل في `transactions` نوع `trip_payment`

```json
{ "success": true, "method": "wallet", "newBalance": 5.129 }
```

#### طريقة `cash`
1. يُسجّل في `transactions` نوع `cash_payment` (بدون خصم)

```json
{ "success": true, "method": "cash" }
```

#### طريقة غير معروفة
```json
{ "success": false, "message": "knet غير متاح حالياً" }
```

---

## 6. PlacesService — `src/services/places.js`

**المسؤوليات:** Proxy لـ Google Maps Places API مع graceful handling لغياب المفتاح.

### الاستخدام

```js
const { getPlacesAutocomplete, getPlaceDetails } = require('./src/services/places');
```

### `getPlacesAutocomplete(input, lat?, lng?): Promise<object>`
- إذا `GOOGLE_MAPS_API_KEY` غير موجود → `{ predictions: [] }`
- يُضيق البحث على الكويت (`components=country:kw`)
- الموقع الافتراضي: `29.3759, 47.9774` (وسط الكويت)

### `getPlaceDetails(placeId): Promise<object>`
- إذا `GOOGLE_MAPS_API_KEY` غير موجود → `{ result: null }`
- الحقول المُعادة: `name, formatted_address, geometry`

### ملاحظة
`GET /places/autocomplete` يُظهر FAIL في الاختبارات لأن بيانات الفوترة في Google Console غير مفعّلة. هذا خطأ خارجي وليس في الكود.

---

## 7. AnalyticsService — `src/services/analytics.js`

**المسؤوليات:** تجميع تقارير وتحليلات متقدمة باستخدام استعلامات متوازية.

### الاستخدام

```js
const { getAnalytics } = require('./src/services/analytics');

const data = await getAnalytics(dbGet, dbAll, period);
```

### `getAnalytics(dbGet, dbAll, period?): Promise<object>`

| المعامل | النوع | الوصف |
|---------|-------|-------|
| `dbGet` | Function | Promise wrapper لـ db.get |
| `dbAll` | Function | Promise wrapper لـ db.all |
| `period` | number | عدد الأيام (1-365)، افتراضي 30 |

**يستخدم `Promise.all()` لتشغيل 9 استعلامات بالتوازي** (تحسين الأداء).

### البيانات المُعادة

```json
{
  "success": true,
  "period": 30,
  "overview": {
    "total": 100,
    "completed": 82,
    "cancelled": 8,
    "revenue": 410.250,
    "avg_fare": 5.003,
    "avg_duration": 28.5,
    "avg_distance": 10.2
  },
  "dailyRevenue": [...],
  "monthlyRevenue": [...],
  "topDrivers": [...],
  "topPickups": [...],
  "topDestinations": [...],
  "avgArrivalTime": 12.3,
  "hourlyDistribution": [...],
  "userGrowth": [...]
}
```
