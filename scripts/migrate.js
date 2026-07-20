#!/usr/bin/env node
'use strict';

/**
 * migrate.js — CLI entry for the versioned migration runner (Phase 12: C1).
 * Uses the configured DB_ENGINE. Under sqlite it drives the existing helpers;
 * under postgres it drives the pooled adapter. Safe/idempotent.
 */

const { DB_ENGINE } = require('../src/config/env');
const logger = require('../src/utils/logger');
const { runFileMigrations } = require('../src/infrastructure/db/migrator');

(async () => {
  let db;
  if (DB_ENGINE === 'postgres') {
    const { createPostgresAdapter } = require('../src/infrastructure/db/postgresAdapter');
    db = createPostgresAdapter(logger);
  } else {
    db = require('../src/config/database'); // exposes dbGet/dbAll/dbRun
  }
  const res = await runFileMigrations({
    dbRun: db.dbRun,
    dbGet: db.dbGet,
    dbAll: db.dbAll,
    engine: DB_ENGINE,
    logger,
  });
  logger.success(`[migrate] engine=${DB_ENGINE} applied=${res.applied}/${res.total}`);
  process.exit(0);
})().catch((e) => {
  logger.error('[migrate] failed', { message: e.message });
  process.exit(1);
});
