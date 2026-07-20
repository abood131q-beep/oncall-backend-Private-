-- 0001_baseline — Phase 12 (C1) versioned-migrations baseline.
-- Engine-neutral, idempotent. Under DB_ENGINE=sqlite the live schema is still
-- created by database.js/migrate.js (the default path); this baseline only
-- establishes the migrations substrate + a platform metadata marker so the
-- versioned pipeline is real and exercisable. Add all future schema changes as
-- new NNNN_*.sql files — never edit an applied one.

CREATE TABLE IF NOT EXISTS platform_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT
);

INSERT INTO platform_meta (key, value, updated_at)
VALUES ('schema_baseline', 'phase-12', '2026-07-20')
ON CONFLICT(key) DO NOTHING;
