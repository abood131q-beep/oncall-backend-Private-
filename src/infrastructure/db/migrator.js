'use strict';

/**
 * migrator.js — Versioned, forward-only migration runner (Phase 12: C1).
 *
 * Applies `migrations/NNNN_*.sql` in order, once each, recording applied
 * versions in a `schema_migrations` table. Engine-agnostic: it drives whatever
 * `dbRun`/`dbGet` it is given (SQLite today, Postgres under DB_ENGINE=postgres),
 * so the same runner works for both. Idempotent and safe to run at boot.
 *
 * This complements (does not replace) the existing imperative bootstrap in
 * database.js / src/config/migrate.js, which remains the default SQLite path.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function listMigrations(engine) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      // engine-specific files: *.pg.sql / *.sqlite.sql; generic otherwise
      if (f.endsWith('.pg.sql')) return engine === 'postgres';
      if (f.endsWith('.sqlite.sql')) return engine === 'sqlite';
      return true;
    })
    .sort();
}

function versionOf(filename) {
  const m = /^(\d+)/.exec(filename);
  return m ? m[1] : filename;
}

async function runFileMigrations({ dbRun, dbGet, engine = 'sqlite', logger } = {}) {
  await dbRun(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT)'
  );
  const files = listMigrations(engine);
  let applied = 0;
  for (const file of files) {
    const version = versionOf(file);
    const seen = await dbGet('SELECT version FROM schema_migrations WHERE version = ?', [version]);
    if (seen) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Split on ";" at line ends — simple statement splitter for plain DDL.
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await dbRun(stmt);
    await dbRun('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
      version,
      new Date().toISOString(),
    ]);
    applied++;
    logger && logger.info && logger.info(`[migrate] applied ${file}`);
  }
  return { applied, total: files.length };
}

module.exports = { runFileMigrations, listMigrations, versionOf, MIGRATIONS_DIR };
