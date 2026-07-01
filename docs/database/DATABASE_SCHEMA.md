# OnCall Database Schema

> **النوع:** SQLite 3 مع `better-sqlite3`
> **الوضع:** WAL (Write-Ahead Logging) — أداء أفضل للقراءة المتزامنة
> **المسار:** `./oncall.db`
> **الجداول:** 11 جدول فعلي + `sqlite_sequence`
> **الفهارس:** 10 فهارس

---

## الجداول

### 1. `users` — المستخدمون (الركاب)

| العمود | النوع | القيود | الافتراضي | الوصف |
|--------|-------|--------|-----------|-------|
| `id` | INTEGER | PK | auto | معرّف المستخدم |
| `phone` | TEXT | NOT NULL | — | رقم الهاتف (المعرّف الحقيقي) |
| `name` | TEXT | — | 'راكب' | اسم المستخدم |
| `balance` | REAL | — | 10.0 | رصيد المحفظة (KD) |
| `total_trips` | INTEGER | — | 0 | عدد الرحلات الكلي |
| `total_spent` | REAL | — | 0 | المبلغ الكلي المنفق |
| `is_active` | INTEGER | — | 1 | 1=نشط, 0=موقوف |
| `created_at` | DATETIME | — | NOW | تاريخ التسجيل |
| `updated_at` | DATETIME | — | NOW | آخر تحديث |

**الفهارس:** `idx_users_phone ON users(phone)`

---

### 2. `drivers` — السائقون

| العمود | النوع | القيود | الافتراضي | الوصف |
|--------|-------|--------|-----------|-------|
| `id` | INTEGER | PK | auto | معرّف السائق |
| `phone` | TEXT | NOT NULL | — | رقم الهاتف |
| `name` | TEXT | — | 'سائق' | اسم السائق |
| `car_name` | TEXT | — | '' | نوع السيارة |
| `car_model` | TEXT | — | '' | موديل السيارة |
| `car_year` | INTEGER | — | 0 | سنة الصنع |
| `plate` | TEXT | — | '' | رقم اللوحة |
| `color` | TEXT | — | '' | لون السيارة |
| `rating` | REAL | — | 5.0 | متوسط التقييم (1-5) |
| `total_ratings` | INTEGER | — | 0 | عدد التقييمات |
| `status` | TEXT | — | 'offline' | online/offline/busy |
| `lat` | REAL | — | 29.3765 | خط العرض الحالي |
| `lng` | REAL | — | 47.9785 | خط الطول الحالي |
| `total_trips` | INTEGER | — | 0 | عدد الرحلات الكلي |
| `total_earnings` | REAL | — | 0 | الأرباح الكلية |
| `acceptance_rate` | REAL | — | 100 | نسبة القبول % |
| `is_active` | INTEGER | — | 1 | 1=نشط, 0=موقوف |
| `created_at` | DATETIME | — | NOW | تاريخ التسجيل |
| `updated_at` | DATETIME | — | NOW | آخر تحديث |

**الفهارس:**
- `idx_drivers_phone ON drivers(phone)`
- `idx_drivers_status ON drivers(status)`

---

### 3. `taxis` — مركبات التاكسي

| العمود | النوع | القيود | الافتراضي | الوصف |
|--------|-------|--------|-----------|-------|
| `id` | INTEGER | PK | auto | معرّف المركبة |
| `name` | TEXT | NOT NULL | — | اسم المركبة |
| `lat` | REAL | — | 29.3765 | خط العرض الحالي |
| `lng` | REAL | — | 47.9785 | خط الطول الحالي |
| `status` | TEXT | — | 'online' | online/offline/busy |
| `driver_id` | INTEGER | FK→drivers.id | NULL | السائق المرتبط |

> **علاقة 1:1** بين السائق والتاكسي عبر `driver_id`.

---

### 4. `trips` — رحلات التاكسي

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | معرّف الرحلة |
| `user_phone` | TEXT | هاتف الراكب |
| `user_id` | INTEGER | معرّف الراكب |
| `driver_name` | TEXT | اسم السائق |
| `driver_id` | INTEGER | معرّف السائق |
| `pickup` | TEXT NOT NULL | اسم موقع الانطلاق |
| `destination` | TEXT NOT NULL | اسم الوجهة |
| `pickup_lat/lng` | REAL | إحداثيات الانطلاق |
| `dest_lat/lng` | REAL | إحداثيات الوجهة |
| `driver_lat/lng` | REAL | آخر موقع للسائق |
| `status` | TEXT | انظر جدول الحالات أدناه |
| `rejected_drivers` | TEXT | JSON array لـ IDs السائقين الرافضين |
| `assigned_driver_id` | INTEGER | السائق المُعيَّن حالياً |
| `estimated_fare` | REAL | الأجرة المقدّرة (KD) |
| `final_fare` | REAL | الأجرة الفعلية (KD) |
| `payment_method` | TEXT | cash/wallet |
| `payment_status` | TEXT | pending/completed |
| `rating` | INTEGER | تقييم الراكب للسائق (1-5) |
| `rating_comment` | TEXT | تعليق الراكب |
| `driver_rating` | INTEGER | تقييم السائق للراكب |
| `driver_rating_comment` | TEXT | تعليق السائق |
| `passenger_rating` | INTEGER | (مكرر مع `rating`) |
| `route` | TEXT | JSON array لنقاط المسار |
| `start_time` | INTEGER | Unix timestamp بداية الرحلة |
| `end_time` | DATETIME | نهاية الرحلة |
| `total_distance` | REAL | المسافة الكلية (km) |
| `duration_minutes` | INTEGER | مدة الرحلة |
| `cancelled_by` | TEXT | passenger/driver/admin |
| `cancel_reason` | TEXT | سبب الإلغاء |
| `created_at` | DATETIME | تاريخ إنشاء الطلب |

**حالات الرحلة:**

```
waiting_driver  → السيستم يبحث عن سائق
accepted        → السائق قبل
arrived         → السائق وصل لموقع الراكب
in_progress     → الرحلة بدأت
completed       → اكتملت
cancelled       → ألغيت
no_driver_found → لم يُعثر على سائق
```

**الفهارس:**
- `idx_trips_phone ON trips(user_phone)`
- `idx_trips_driver ON trips(driver_id)`
- `idx_trips_status ON trips(status)`
- `idx_trips_created ON trips(created_at)`

---

### 5. `scooters` — السكوترات

| العمود | النوع | الافتراضي | الوصف |
|--------|-------|-----------|-------|
| `id` | INTEGER PK | auto | معرّف السكوتر |
| `name` | TEXT NOT NULL | — | اسم السكوتر |
| `scooter_code` | TEXT | NULL | رمز QR |
| `lat` | REAL | 29.3759 | خط العرض |
| `lng` | REAL | 47.9774 | خط الطول |
| `battery` | INTEGER | 100 | البطارية % |
| `status` | TEXT | 'available' | available/riding/maintenance |
| `current_user_phone` | TEXT | NULL | المستخدم الحالي |
| `ride_start_time` | INTEGER | NULL | Unix timestamp بداية الرحلة |
| `total_rentals` | INTEGER | 0 | عدد الإيجارات الكلي |
| `created_at` | DATETIME | NOW | — |

**أجرة السكوتر:** `max(0.500, minutes × 0.050)` KD

---

### 6. `scooter_rides` — سجل رحلات السكوتر

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `scooter_id` | INTEGER | FK→scooters.id |
| `user_phone` | TEXT | هاتف المستخدم |
| `start_time` | INTEGER | Unix timestamp |
| `end_time` | INTEGER | Unix timestamp |
| `duration_minutes` | INTEGER | مدة الرحلة |
| `fare` | REAL | الأجرة (KD) |
| `end_lat/end_lng` | REAL | موقع نهاية الرحلة |
| `status` | TEXT | active/completed |
| `created_at` | DATETIME | — |

**الفهارس:** `idx_scooter_rides_phone ON scooter_rides(user_phone)`

---

### 7. `transactions` — السجل المالي

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `phone` | TEXT NOT NULL | هاتف المستخدم |
| `type` | TEXT NOT NULL | انظر الأنواع أدناه |
| `amount` | REAL NOT NULL | المبلغ (KD) |
| `balance_before` | REAL | الرصيد قبل |
| `balance_after` | REAL | الرصيد بعد |
| `description` | TEXT | وصف العملية |
| `trip_id` | INTEGER | الرحلة المرتبطة |
| `status` | TEXT | completed/pending/failed |
| `created_at` | DATETIME | — |

**أنواع العمليات:**

| النوع | الوصف |
|-------|-------|
| `deposit` | شحن رصيد |
| `trip_payment` | دفع أجرة (محفظة) |
| `cash_payment` | دفع نقدي (تسجيل فقط) |
| `scooter_payment` | دفع إيجار سكوتر |

**الفهارس:** `idx_transactions_phone ON transactions(phone)`

---

### 8. `notifications` — الإشعارات

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `phone` | TEXT NOT NULL | المستلم |
| `title` | TEXT NOT NULL | عنوان الإشعار |
| `body` | TEXT NOT NULL | نص الإشعار |
| `type` | TEXT | general/scooter_unlocked/wallet_charge/... |
| `is_read` | INTEGER | 0=غير مقروء, 1=مقروء |
| `trip_id` | INTEGER | الرحلة المرتبطة |
| `created_at` | DATETIME | — |

**الفهارس:** `idx_notifications_phone ON notifications(phone)`

---

### 9. `reports` — البلاغات

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `phone` | TEXT NOT NULL | المُبلِّغ |
| `type` | TEXT | general/driver_behavior/payment/... |
| `description` | TEXT | وصف المشكلة |
| `trip_id` | INTEGER | الرحلة المرتبطة |
| `status` | TEXT | pending/resolved |
| `created_at` | DATETIME | — |

---

### 10. `login_logs` — سجلات الدخول

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `phone` | TEXT NOT NULL | رقم الهاتف |
| `type` | TEXT NOT NULL | passenger/driver |
| `ip` | TEXT | IP العميل |
| `device` | TEXT | معلومات الجهاز |
| `created_at` | DATETIME | — |

---

### 11. `wallets` — المحافظ (موروث)

> ⚠️ **ملاحظة:** هذا الجدول موروث من نسخة سابقة. يُستخدم `users.balance` حالياً بدلاً منه.

| العمود | النوع | الوصف |
|--------|-------|-------|
| `id` | INTEGER PK | — |
| `phone` | TEXT NOT NULL | — |
| `type` | TEXT | passenger/driver |
| `balance` | REAL | الرصيد |
| `total_added` | REAL | إجمالي الشحن |
| `total_spent` | REAL | إجمالي الإنفاق |
| `created_at` | DATETIME | — |
| `updated_at` | DATETIME | — |

---

## الفهارس الكاملة (10 فهارس)

| الفهرس | الجدول | العمود | الغرض |
|--------|--------|--------|-------|
| `idx_users_phone` | users | phone | بحث المستخدمين بالهاتف |
| `idx_drivers_phone` | drivers | phone | بحث السائقين بالهاتف |
| `idx_drivers_status` | drivers | status | تصفية السائقين المتاحين |
| `idx_trips_phone` | trips | user_phone | رحلات راكب محدد |
| `idx_trips_driver` | trips | driver_id | رحلات سائق محدد |
| `idx_trips_status` | trips | status | تصفية الرحلات بالحالة |
| `idx_trips_created` | trips | created_at | تقارير زمنية |
| `idx_transactions_phone` | transactions | phone | سجل مالي للمستخدم |
| `idx_notifications_phone` | notifications | phone | إشعارات المستخدم |
| `idx_scooter_rides_phone` | scooter_rides | user_phone | سجل ركوب السكوتر |

---

## العلاقات

```
users.phone         ──(1:N)──> trips.user_phone
users.phone         ──(1:N)──> transactions.phone
users.phone         ──(1:N)──> notifications.phone
users.phone         ──(1:N)──> scooter_rides.user_phone
users.phone         ──(1:N)──> reports.phone

drivers.id          ──(1:N)──> trips.driver_id
drivers.id          ──(1:1)──> taxis.driver_id

scooters.id         ──(1:N)──> scooter_rides.scooter_id
trips.id            ──(1:N)──> transactions.trip_id
trips.id            ──(1:N)──> notifications.trip_id
trips.id            ──(1:N)──> reports.trip_id
```

---

## إعدادات الأداء

```sql
PRAGMA journal_mode = WAL;        -- كتابة أسرع، قراءة متزامنة
PRAGMA foreign_keys = ON;         -- تفعيل القيود المرجعية
PRAGMA cache_size = -64000;       -- Cache 64MB
PRAGMA temp_store = MEMORY;       -- المؤقتات في الذاكرة
```
