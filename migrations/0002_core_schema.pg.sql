-- 0002_core_schema (PostgreSQL only) — Phase 13 SQLite→Postgres migration.
-- Production baseline schema for DB_ENGINE=postgres. Type choices are made to
-- keep JSON responses BYTE-IDENTICAL to the SQLite build:
--   * id  : BIGSERIAL (returned as JS number via the adapter's int8 parser)
--   * money/coords (SQLite REAL) : DOUBLE PRECISION  (JS number — NOT numeric,
--     which node-postgres would return as a string and break the contract)
--   * 0/1 flags (is_read, revoked, is_active…) : INTEGER  (keeps 0/1, not true/false)
--   * datetimes : TIMESTAMPTZ  (the adapter formats Date→'YYYY-MM-DD HH24:MI:SS'
--     to match SQLite's CURRENT_TIMESTAMP text; see sqlDialect.formatSqliteDatetime)
-- ON CONFLICT / excluded / CURRENT_TIMESTAMP are used unchanged (PG-compatible).
-- Idempotent (IF NOT EXISTS) and forward-only.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT 'راكب',
  balance DOUBLE PRECISION DEFAULT 10.0,
  total_trips INTEGER DEFAULT 0,
  total_spent DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT 'سائق',
  car_name TEXT DEFAULT '',
  car_model TEXT DEFAULT '',
  car_year INTEGER DEFAULT 0,
  plate TEXT DEFAULT '',
  color TEXT DEFAULT '',
  rating DOUBLE PRECISION DEFAULT 5.0,
  total_ratings INTEGER DEFAULT 0,
  status TEXT DEFAULT 'offline',
  lat DOUBLE PRECISION DEFAULT 29.3765,
  lng DOUBLE PRECISION DEFAULT 47.9785,
  total_trips INTEGER DEFAULT 0,
  total_earnings DOUBLE PRECISION DEFAULT 0,
  acceptance_rate DOUBLE PRECISION DEFAULT 100,
  approval_status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scooters (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  scooter_code TEXT UNIQUE,
  lat DOUBLE PRECISION DEFAULT 29.3759,
  lng DOUBLE PRECISION DEFAULT 47.9774,
  battery INTEGER DEFAULT 100,
  status TEXT DEFAULT 'available',
  current_user_phone TEXT,
  total_rentals INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxis (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION DEFAULT 29.3765,
  lng DOUBLE PRECISION DEFAULT 47.9785,
  status TEXT DEFAULT 'online',
  driver_id INTEGER
);

CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT,
  user_id INTEGER,
  driver_name TEXT,
  driver_id INTEGER,
  pickup TEXT NOT NULL,
  destination TEXT NOT NULL,
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  dest_lat DOUBLE PRECISION,
  dest_lng DOUBLE PRECISION,
  driver_lat DOUBLE PRECISION,
  driver_lng DOUBLE PRECISION,
  status TEXT DEFAULT 'waiting_driver',
  rejected_drivers TEXT DEFAULT '[]',
  assigned_driver_id INTEGER,
  assigned_driver_name TEXT,
  request_sent_at BIGINT,
  estimated_fare DOUBLE PRECISION DEFAULT 1.0,
  final_fare DOUBLE PRECISION,
  payment_method TEXT DEFAULT 'cash',
  payment_status TEXT DEFAULT 'pending',
  rating INTEGER,
  route TEXT DEFAULT '[]',
  start_time BIGINT,
  end_time TIMESTAMPTZ,
  total_distance DOUBLE PRECISION DEFAULT 0,
  duration_minutes INTEGER DEFAULT 0,
  cancelled_by TEXT,
  cancel_reason TEXT,
  rating_comment TEXT,
  driver_rating INTEGER,
  driver_rating_comment TEXT,
  passenger_rating INTEGER,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  -- Parity with the SQLite trips schema (which has updated_at): without this the PG trip JSON
  -- omitted updated_at, breaking the SQLite≡PostgreSQL cross-engine A/B (trip:create, trips:paged).
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'passenger',
  balance DOUBLE PRECISION DEFAULT 0,
  total_added DOUBLE PRECISION DEFAULT 0,
  total_spent DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  balance_before DOUBLE PRECISION DEFAULT 0,
  balance_after DOUBLE PRECISION DEFAULT 0,
  description TEXT,
  trip_id INTEGER,
  status TEXT DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_logs (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  type TEXT NOT NULL,
  ip TEXT,
  device TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'general',
  is_read INTEGER DEFAULT 0,
  trip_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  type TEXT DEFAULT 'general',
  description TEXT,
  trip_id INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scooter_rides (
  id BIGSERIAL PRIMARY KEY,
  scooter_id INTEGER NOT NULL,
  user_phone TEXT NOT NULL,
  start_time BIGINT,
  end_time BIGINT,
  duration_minutes INTEGER DEFAULT 0,
  fare DOUBLE PRECISION DEFAULT 0,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  device_token TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT DEFAULT '',
  last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phone, device_token)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'passenger',
  driver_id INTEGER,
  name TEXT,
  expires_at BIGINT NOT NULL,
  revoked INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Tables added by src/config/migrate.js (auth/rate-limit/approval infra)
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  phone TEXT PRIMARY KEY,
  revoked_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_locks (
  phone TEXT PRIMARY KEY,
  locked_until BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_approval_logs (
  id BIGSERIAL PRIMARY KEY,
  driver_phone TEXT NOT NULL,
  admin_phone TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexes (mirror the SQLite build)
CREATE INDEX IF NOT EXISTS idx_trips_phone ON trips(user_phone);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_trips_created ON trips(created_at);
CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_approval ON drivers(approval_status);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone);
CREATE INDEX IF NOT EXISTS idx_notifications_phone ON notifications(phone);
CREATE INDEX IF NOT EXISTS idx_scooter_rides_phone ON scooter_rides(user_phone);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rt_phone ON refresh_tokens(phone);
CREATE INDEX IF NOT EXISTS idx_dt_phone ON device_tokens(phone);
CREATE INDEX IF NOT EXISTS idx_dt_token ON device_tokens(device_token);
CREATE INDEX IF NOT EXISTS idx_approval_logs_driver ON driver_approval_logs(driver_phone);
