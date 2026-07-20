const sqlite3 = require('sqlite3').verbose();

// P6-05B: DB_PATH sourced from env.js (single source of truth).
// env.js is guaranteed to load before database.js in server.js startup order.
// Node.js module cache ensures env.js runs only once even with multiple requires.
const { DB_PATH, IS_PRODUCTION } = require('./src/config/env');
const db = new sqlite3.Database(DB_PATH);

// P6-06 FIX: busyTimeout=0 → BEGIN IMMEDIATE يفشل فوراً عند وجود lock
// السبب: sqlite3 Node.js يستخدم background thread واحد لكل connection.
// إذا انتظر busy handler فيه، يُحجب الـ thread → لا تستطيع العمليات الأخرى
// (db.get داخل Transaction A) من الاكتمال → deadlock حتى timeout.
// الحل: نتيجة SQLITE_BUSY فورية + retry بـ setTimeout (JS level - non-blocking).
// dbTransaction في src/config/database.js يتولى الـ retry.
db.configure('busyTimeout', 0);

db.serialize(() => {
  // ===== المستخدمون =====
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'راكب',
      balance REAL DEFAULT 10.0,
      total_trips INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== السائقون =====
  db.run(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'سائق',
      car_name TEXT DEFAULT '',
      car_model TEXT DEFAULT '',
      car_year INTEGER DEFAULT 0,
      plate TEXT DEFAULT '',
      color TEXT DEFAULT '',
      rating REAL DEFAULT 5.0,
      total_ratings INTEGER DEFAULT 0,
      status TEXT DEFAULT 'offline',
      lat REAL DEFAULT 29.3765,
      lng REAL DEFAULT 47.9785,
      total_trips INTEGER DEFAULT 0,
      total_earnings REAL DEFAULT 0,
      acceptance_rate REAL DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== السكوترات =====
  db.run(`
    CREATE TABLE IF NOT EXISTS scooters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scooter_code TEXT UNIQUE,
      lat REAL DEFAULT 29.3759,
      lng REAL DEFAULT 47.9774,
      battery INTEGER DEFAULT 100,
      status TEXT DEFAULT 'available',
      current_user_phone TEXT,
      total_rentals INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== التاكسيات =====
  db.run(`
    CREATE TABLE IF NOT EXISTS taxis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lat REAL DEFAULT 29.3765,
      lng REAL DEFAULT 47.9785,
      status TEXT DEFAULT 'online',
      driver_id INTEGER,
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    )
  `);

  // ===== الرحلات =====
  db.run(`
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_phone TEXT,
      user_id INTEGER,
      driver_name TEXT,
      driver_id INTEGER,
      pickup TEXT NOT NULL,
      destination TEXT NOT NULL,
      pickup_lat REAL,
      pickup_lng REAL,
      dest_lat REAL,
      dest_lng REAL,
      driver_lat REAL,
      driver_lng REAL,
      status TEXT DEFAULT 'waiting_driver',
      rejected_drivers TEXT DEFAULT '[]',
      assigned_driver_id INTEGER,
      assigned_driver_name TEXT,
      request_sent_at INTEGER,
      estimated_fare REAL DEFAULT 1.0,
      final_fare REAL,
      payment_method TEXT DEFAULT 'cash',
      payment_status TEXT DEFAULT 'pending',
      rating INTEGER,
      route TEXT DEFAULT '[]',
      start_time INTEGER,
      end_time DATETIME,
      total_distance REAL DEFAULT 0,
      duration_minutes INTEGER DEFAULT 0,
      cancelled_by TEXT,
      cancel_reason TEXT,
      rating_comment TEXT,
      driver_rating INTEGER,
      driver_rating_comment TEXT,
      passenger_rating INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== المحافظ المالية =====
  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      type TEXT DEFAULT 'passenger',
      balance REAL DEFAULT 0,
      total_added REAL DEFAULT 0,
      total_spent REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== سجل العمليات المالية =====
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL DEFAULT 0,
      balance_after REAL DEFAULT 0,
      description TEXT,
      trip_id INTEGER,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== سجل تسجيل الدخول =====
  db.run(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      type TEXT NOT NULL,
      ip TEXT,
      device TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== إشعارات =====
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      is_read INTEGER DEFAULT 0,
      trip_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== بيانات تجريبية (Development Only) =====
  // P6-05G: لا تُدرَج بيانات تجريبية في بيئة الإنتاج.
  // في الإنتاج يُنشئ المدير السكوترات والتاكسيات عبر لوحة التحكم.
  if (!IS_PRODUCTION) {
    db.get('SELECT COUNT(*) as c FROM scooters', (err, row) => {
      if (row && row.c === 0) {
        db.run(
          `INSERT INTO scooters (name, scooter_code, lat, lng, battery, status) VALUES ('Scooter 001', 'SC001', 29.3759, 47.9774, 85, 'available')`
        );
        db.run(
          `INSERT INTO scooters (name, scooter_code, lat, lng, battery, status) VALUES ('Scooter 002', 'SC002', 29.3780, 47.9800, 60, 'available')`
        );
        db.run(
          `INSERT INTO scooters (name, scooter_code, lat, lng, battery, status) VALUES ('Scooter 003', 'SC003', 29.3800, 47.9750, 90, 'available')`
        );
      }
    });

    db.get('SELECT COUNT(*) as c FROM taxis', (err, row) => {
      if (row && row.c === 0) {
        db.run(
          `INSERT INTO taxis (name, lat, lng, status) VALUES ('Taxi 001', 29.3765, 47.9785, 'online')`
        );
        db.run(
          `INSERT INTO taxis (name, lat, lng, status) VALUES ('Taxi 002', 29.3790, 47.9820, 'online')`
        );
        db.run(
          `INSERT INTO taxis (name, lat, lng, status) VALUES ('Taxi 003', 29.3820, 47.9750, 'online')`
        );
      }
    });

    db.get('SELECT COUNT(*) as c FROM users', (err, row) => {
      if (row && row.c === 0) {
        db.run(`INSERT INTO users (phone, name, balance) VALUES ('99999999', 'مستخدم تجريبي', 10)`);
      }
    });
  }

  // ===== البلاغات =====
  // L-008: نُقل داخل db.serialize() لضمان الترتيب الصحيح مع باقي الجداول
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      description TEXT,
      trip_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== سجل رحلات السكوتر =====
  db.run(`
    CREATE TABLE IF NOT EXISTS scooter_rides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scooter_id INTEGER NOT NULL,
      user_phone TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      duration_minutes INTEGER DEFAULT 0,
      fare REAL DEFAULT 0,
      start_lat REAL,
      start_lng REAL,
      end_lat REAL,
      end_lng REAL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (scooter_id) REFERENCES scooters(id)
    )
  `);

  // ===== Device Tokens — P6-02 =====
  // UNIQUE(phone, device_token): منع تسجيل نفس الجهاز مرتين لنفس المستخدم
  db.run(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      device_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_version TEXT DEFAULT '',
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(phone, device_token)
    )
  `);

  // ===== Refresh Tokens — P6-01 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'passenger',
      driver_id INTEGER,
      name TEXT,
      expires_at INTEGER NOT NULL,
      revoked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ===== Database Indexes للأداء =====
// ALTER TABLE migrations have been consolidated into src/config/migrate.js (runMigrations)
[
  'CREATE INDEX IF NOT EXISTS idx_trips_phone ON trips(user_phone)',
  'CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status)',
  'CREATE INDEX IF NOT EXISTS idx_trips_created ON trips(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id)',
  'CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone)',
  'CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status)',
  'CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)',
  'CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_phone ON notifications(phone)',
  'CREATE INDEX IF NOT EXISTS idx_scooter_rides_phone ON scooter_rides(user_phone)',
  'CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_rt_phone ON refresh_tokens(phone)',
  // P6-02 — Device Tokens
  'CREATE INDEX IF NOT EXISTS idx_dt_phone ON device_tokens(phone)',
  'CREATE INDEX IF NOT EXISTS idx_dt_token ON device_tokens(device_token)',
  // P6-06 indexes (idx_drivers_approval, idx_approval_logs_driver) are created
  // in src/config/migrate.js — AFTER runMigrations() adds the approval_status
  // column and driver_approval_logs table. Running them here (at module load,
  // before migrations) causes: SQLITE_ERROR: no such column: approval_status.
].forEach((sql) => db.run(sql));

module.exports = db;
