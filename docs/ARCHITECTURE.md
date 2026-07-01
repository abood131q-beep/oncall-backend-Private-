# OnCall Backend — Architecture

> **الإصدار:** بعد Phase 4 (Modular Refactoring)
> **التاريخ:** يونيو 2026

---

## نظرة عامة

OnCall هو backend لتطبيق مشاركة المركبات في الكويت يدعم:
- **التاكسي:** طلب رحلة، مطابقة السائق، تتبع الموقع، الدفع
- **السكوتر:** فتح قفل، تتبع الاستخدام، الفوترة التلقائية
- **لوحة الإدارة:** إدارة كاملة عبر REST API
- **MCP Server:** 45 أداة لتكامل AI agents

---

## هيكل الملفات

```
oncall-backend/
├── server.js                    # Entry Point (355 سطر)
├── database.js                  # SQLite setup + Migrations
├── oncall.db                    # قاعدة البيانات
├── .env                         # المتغيرات السرية
│
├── src/
│   ├── config/
│   │   └── env.js               # تحميل .env + التحقق
│   │
│   ├── utils/
│   │   ├── logger.js            # Logger مركزي (logs/server.log)
│   │   └── helpers.js           # دوال مساعدة عامة
│   │
│   ├── middleware/
│   │   ├── auth.js              # JWT + Express middleware
│   │   └── rateLimiter.js       # Rate limiting في الذاكرة
│   │
│   ├── routes/
│   │   ├── health.js            # GET / /test /health
│   │   ├── auth.js              # POST /login /driver/login /logout
│   │   ├── users.js             # /user /balance /notifications /report
│   │   ├── drivers.js           # /driver/*
│   │   ├── scooters.js          # /scooters /scooter/*
│   │   ├── taxi.js              # /taxis /taxi/* /places/*
│   │   ├── payment.js           # /wallet /fare /payment
│   │   └── admin.js             # /admin/*
│   │
│   └── services/
│       ├── backup.js            # نسخ احتياطية تلقائية
│       ├── cache.js             # In-memory Cache
│       ├── fareCalculator.js    # حساب الأجرة
│       ├── driverMatcher.js     # مطابقة السائقين
│       ├── payment.js           # معالجة المدفوعات
│       ├── places.js            # Google Maps Proxy
│       └── analytics.js         # تقارير متقدمة
│
├── docs/
│   ├── ARCHITECTURE.md          # هذا الملف
│   ├── routes/
│   │   └── API_REFERENCE.md     # توثيق جميع Endpoints
│   ├── services/
│   │   └── SERVICES_REFERENCE.md
│   └── database/
│       └── DATABASE_SCHEMA.md   # schema الجداول والفهارس
│
├── tests/                       # اختبارات المستقبل
├── scripts/                     # سكريبتات المساعدة
├── backups/                     # نسخ احتياطية (oncall-*.db)
├── logs/                        # ملفات السجل
│
└── tools/oncall-mcp/            # MCP Server (TypeScript)
    ├── src/
    │   ├── server.ts
    │   ├── tools/               # 45 أداة منظمة في ملفات
    │   ├── http-client.ts
    │   └── token-manager.ts
    └── dist/                    # JS compiled
```

---

## مخطط البنية

```
┌─────────────────────────────────────────────────────┐
│                   Flutter App                        │
│           (iOS / Android / Web)                      │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS/WSS
               ▼
┌─────────────────────────────────────────────────────┐
│              Express.js Server                       │
│                server.js (Entry Point)               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  CORS    │  │BodyParser│  │  Response Timer   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────────────────────────────────────────┐   │
│  │          Rate Limiter (In-Memory)             │   │
│  │  IP Map (normalLimit/strictLimit/loginLimit)  │   │
│  │  Phone Map (phoneLoginLimit)                  │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │                Routes Layer                   │   │
│  │  health → auth → users → drivers → scooters  │   │
│  │  → taxi → payment → admin                    │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │               Services Layer                  │   │
│  │  Cache | FareCalc | DriverMatcher | Payment   │   │
│  │  Places | Analytics | Backup                  │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │            Database Layer (SQLite)             │   │
│  │          better-sqlite3 + WAL mode             │   │
│  └──────────────────────────────────────────────┘   │
└──────────┬──────────────────────────┬───────────────┘
           │ Socket.IO                │ REST
           ▼                          ▼
┌────────────────┐          ┌─────────────────────┐
│  Driver App    │          │   MCP Server         │
│  (Real-time)   │          │   (TypeScript)       │
│  - location    │          │   45 tools → Claude  │
│  - trip events │          └─────────────────────┘
└────────────────┘
```

---

## نمط التصميم

### Factory Function + Dependency Injection

كل Route و Service يستخدم نمط Factory Function:

```js
// Route
module.exports = function createTaxiRouter(svc) {
  const router = express.Router();
  const { dbGet, dbRun, io, calculateFare } = svc; // Destructure ما يحتاجه فقط
  // ... routes
  return router;
};

// Service
function createDriverMatcher(svc) {
  const { dbGet, dbAll, io, tripTimers } = svc;
  return { findNearestDriver, sendRequestToDriver };
}
```

**كائن `services`** في server.js يجمع كل الاعتماديات:

```js
const services = {
  dbGet, dbRun, dbAll,          // قاعدة البيانات
  logger,                        // السجلات
  authenticate, authenticateAdmin, generateJWT, verifyJWT,
  loginLimit, phoneLoginLimit,
  cache, getCache, setCache, clearCache, CACHE_TTL,
  ADMIN_PHONES, FARE_CONFIG,
  calculateFare, getFareBreakdown, getPriceMultiplier,
  formatTrip, safeJSON, getDistanceKm,
  io, tripTimers,                // Socket.IO
  createBackup,
  getMetrics,                    // مقاييس الأداء
};
```

---

## تدفق المصادقة

```
Client → POST /login (phone)
  ↓
JWT = createHmac('sha256', JWT_SECRET)
  payload = { phone, type, role, name, exp: +24h }
  ↓
Response: { token: "eyJ...", user: {...} }

Client → GET /taxi/trips (Authorization: Bearer <token>)
  ↓
authenticate middleware:
  → verifyJWT(token)
  → if invalid → 401
  → req.user = payload
  → next()
```

---

## تدفق طلب التاكسي

```
POST /taxi/request
  ↓
احسب المسافة (Haversine)
احسب الأجرة (FareCalculatorService)
احفظ رحلة جديدة status='waiting_driver'
  ↓
DriverMatcherService.findNearestDriver()
  → جلب السائقين status='online'
  → استبعاد rejected_drivers
  → ترتيب بالمسافة
  → اختر الأقرب
  ↓
sendRequestToDriver(trip, driver)
  → حدّث trips: assigned_driver_id = driver.id
  → Socket.IO emit('trip:request') → driver room
  → setTimeout(30s):
      إذا لم يقبل → findNearestDriver(excludeIds=[driver.id])
      إذا لا سائق → status='no_driver_found'
  ↓
السائق: PUT /taxi/trips/:id/status { status: 'accepted' }
  → clearTimeout(tripTimer)
  → حدّث taxis: status='busy'
  → Socket.IO emit('trip:accepted') → passenger room
  ↓
... accepted → arrived → in_progress → completed
  ↓
PaymentService.processPayment()
  → wallet: خصم من users.balance + تسجيل في transactions
  → cash: تسجيل فقط
```

---

## نظام Cache

```
Request → getCache('scooters')
  ├── Cache Hit (< 10s) → Response فوري
  └── Cache Miss → dbAll() → setCache('scooters', data, 10000) → Response

تنظيف: setInterval كل 30 ثانية يحذف المنتهي الصلاحية
```

---

## تدفق Socket.IO

```
السائق يتصل:
  socket.join('driver:' + phone)

الراكب يتصل:
  socket.join('passenger:' + phone)

طلب رحلة → io.to('driver:' + driverPhone).emit('trip:request', trip)
قبول رحلة → io.to('passenger:' + phone).emit('trip:accepted', trip)
تحديث موقع → io.to('trip:' + tripId).emit('driver:location', {lat, lng})
```

---

## Rate Limiting

| Middleware | الحد | النطاق |
|-----------|------|-------|
| `normalLimit` | 60 طلب/دقيقة | IP |
| `strictLimit` | 30 طلب/دقيقة | IP |
| `loginLimit` | 10 طلبات/دقيقة | IP |
| `phoneLoginLimit` | 5 طلبات/دقيقة | رقم هاتف |

تنظيف تلقائي: كل 5 دقائق.

---

## MCP Server

**الموقع:** `tools/oncall-mcp/`
**التقنية:** TypeScript + `@modelcontextprotocol/sdk`
**عدد الأدوات:** 45 أداة
**المصادقة:** Admin JWT محفوظ في `token-manager.ts`

**فئات الأدوات:**
- إدارة المستخدمين (8 أدوات)
- إدارة السائقين (8 أدوات)
- إدارة السكوترات (6 أدوات)
- إدارة الرحلات (10 أدوات)
- إدارة البيانات (7 أدوات)
- المراقبة والتشخيص (6 أدوات)

---

## الأولويات الهندسية

```
1. الاستقرار   — لا انهيارات، تعامل مع جميع الأخطاء
2. الأمان      — JWT، parameterized queries، input validation
3. الأداء      — Cache، WAL mode، Promise.all()
4. الصيانة     — كود نظيف، توثيق، هيكل modular
5. المميزات    — إضافة ميزات جديدة بعد الأساس
```

---

## قرارات تقنية مهمة

| القرار | السبب |
|--------|-------|
| SQLite بدلاً من PostgreSQL | تبسيط النشر، كافٍ للحجم الحالي |
| JWT محلي بدلاً من مكتبة | تحكم كامل، تبعيات أقل |
| In-memory Rate Limit | لا حاجة لـ Redis لحجم واحد سيرفر |
| In-memory Cache | بيانات صغيرة، TTL قصير |
| Factory Function + DI | قابلية اختبار عالية، تجنب globals |
| CommonJS (require) | توافق مع Node.js القديم ونظام المشروع |
| Socket.IO بدلاً من WebSocket خام | reconnection تلقائي، rooms جاهزة |
