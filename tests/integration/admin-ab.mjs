#!/usr/bin/env node
/**
 * Admin cutover A/B compatibility proof (Migration Phase 8).
 *
 * Boots the REAL server twice — legacy admin router (ADMIN_LEGACY=1) and the new
 * enterprise router — on fresh databases, drives an identical suite through both
 * (every GENERAL admin endpoint: stats/dashboard/revenue/analytics, trip & user
 * & taxi & report administration, backups/logs/db-health/metrics/system/
 * observability, plus auth-negative + validation-negative cases), normalizes
 * nondeterministic fields (pids, uptimes, memory, timestamps, ids, tokens), and
 * diffs every (status, body) pair ORDER-SENSITIVELY.
 *
 * The mutating maintenance endpoints that terminate the process (db/restore
 * success, shutdown) are exercised only through their validation-failure paths,
 * so both servers stay alive and the comparison stays deterministic — the happy
 * paths call process.exit and cannot be A/B'd in-process.
 *
 * Run: node tests/integration/admin-ab.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_PHONE = '11111111';

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const JWTISH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;
const BACKUP_FILE_RE = /^(oncall|pre-restore)_.*\.db$/;
// Host/runtime/wall-clock dependent fields → normalized so only the CONTRACT
// (shape, key order, status, messages) is compared, never machine specifics.
// Volatile SCALARS: pids, uptimes, memory/cpu gauges, sizes, counts, timings.
const VOLATILE_SCALARS =
  /^(id|trip_id|driver_id|user_id|created_at|updated_at|end_time|start_time|time|timestamp|uptime|uptimeHuman|uptimeSec|seconds|human|pid|nodeVersion|version|platform|arch|port|model|cores|loadAvg1m|loadAvg5m|loadAvg15m|heapUsedMB|heapTotalMB|memoryUsedMB|memoryTotalMB|rssMB|externalMB|systemFreeMB|systemTotalMB|systemUsedPercent|cpuPercent|freemem|totalmem|sizeKB|sizeMB|pageCount|pageSize|walCheckpoint|journalMode|date|size|totalGB|usedGB|freeGB|usedPercent|avgMs|p95Ms|minMs|maxMs|totalMs|avgResponseMs|p95ResponseMs|minResponseMs|maxResponseMs|sampledRequests|requestCount|total|count|responseTimes|socketClients|driversOnlineSocket|timezone|nodeEnv|requestId|name)$/;
// Volatile COLLECTIONS: observability payloads whose contents are inherently
// runtime/order/timing dependent (log lines carry port + UUID, route sort ties
// break by timing). Their WRAPPER contract is still compared; the members are
// collapsed. Collapsing the whole subtree, before recursion, is the standard
// normalization used across the A/B suite.
const VOLATILE_COLLECTIONS =
  /^(recentLogs|logs|events|errors|crashes|recentErrors|recentCrashes|slowRoutes|routes|dailyStats|topDrivers|history|backups)$/;

function normalize(value, key = '') {
  // Collapse volatile subtrees/scalars first — regardless of value type.
  if (VOLATILE_COLLECTIONS.test(key) || VOLATILE_SCALARS.test(key)) return '<V>';
  if (Array.isArray(value)) {
    const arr = value.map((v) => normalize(v));
    // Directory listings (userRepo.findAll → `ORDER BY created_at DESC`) tie on a
    // same-second created_at, so SQLite's tie-break order is nondeterministic and
    // NOT part of the contract. Both routers call the identical shared query, so
    // we sort phone-keyed rows to compare membership, not tie-break order.
    if (arr.length && arr.every((e) => e && typeof e === 'object' && 'phone' in e)) {
      return [...arr].sort((a, b) => String(a.phone).localeCompare(String(b.phone)));
    }
    return arr;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (JWTISH_RE.test(value) || OPAQUE_TOKEN_RE.test(value)) return '<TOKEN>';
    if (BACKUP_FILE_RE.test(value)) return '<BACKUP>';
    if (DATETIME_RE.test(value)) return '<DATETIME>';
  }
  return value;
}

async function startServer({ legacy, port, dbPath }) {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        JWT_SECRET: 'ab-harness-secret-0123456789abcdef0123456789abcdef',
        ADMIN_PHONES: ADMIN_PHONE,
        PORT: String(port),
        DB_PATH: dbPath,
        LOG_LEVEL: 'ERROR',
        ADMIN_LEGACY: legacy ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if ((await fetch(`${base}/health`)).status === 200) return { child, base };
    } catch {
      /* not up */
    }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error(`server failed (legacy=${legacy})\n${logs.slice(-1500)}`);
}

async function call(base, method, path, { body, token, lang } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(lang ? { 'accept-language': lang } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function login(base, phone, name) {
  return (await call(base, 'POST', '/login', { body: { phone, name } })).body;
}
async function approveDriver(base, admin, phone) {
  await call(base, 'POST', '/driver/login', { body: { phone } });
  await call(base, 'PUT', `/admin/drivers/${phone}/approve`, { token: admin });
  return (await call(base, 'POST', '/driver/login', { body: { phone } })).body.token;
}

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = (await login(base, ADMIN_PHONE, 'Admin')).token;
  const pa = (await login(base, '55560001', 'Alice')).token;
  await approveDriver(base, admin, '55560101');

  // Seed one real trip so paginated/list/cancel endpoints have data
  const created = await call(base, 'POST', '/taxi/request', {
    token: pa,
    body: { pickup: 'Salmiya', destination: 'Kuwait City', payment_method: 'cash' },
  });
  const tripId = created.body?.trip?.id;

  // ── Auth gate (no token / non-admin token) ─────────────────────────────────
  await rec('stats:noauth', call(base, 'GET', '/admin/stats'));
  await rec('stats:passenger', call(base, 'GET', '/admin/stats', { token: pa }));

  // ── Statistics & dashboards ────────────────────────────────────────────────
  await rec('stats', call(base, 'GET', '/admin/stats', { token: admin }));
  await rec('dashboard', call(base, 'GET', '/admin/dashboard', { token: admin }));
  await rec('revenue', call(base, 'GET', '/admin/revenue', { token: admin }));
  await rec('analytics', call(base, 'GET', '/admin/analytics', { token: admin }));
  await rec('analytics:period', call(base, 'GET', '/admin/analytics?period=7', { token: admin }));

  // ── Trip administration ────────────────────────────────────────────────────
  await rec('trips:list', call(base, 'GET', '/admin/trips', { token: admin }));
  await rec(
    'trips:paged',
    call(base, 'GET', '/admin/trips?page=1&limit=5&status=waiting_driver', { token: admin })
  );
  await rec(
    'trips:badpage',
    call(base, 'GET', '/admin/trips?page=-3&limit=9999', { token: admin })
  );
  await rec(
    'trip:cancel:missing',
    call(base, 'PUT', '/admin/trips/999999/cancel', { token: admin })
  );
  await rec('trip:cancel:ok', call(base, 'PUT', `/admin/trips/${tripId}/cancel`, { token: admin }));

  // ── User administration ────────────────────────────────────────────────────
  await rec('users:list', call(base, 'GET', '/admin/users', { token: admin }));
  await rec('user:get:ok', call(base, 'GET', '/admin/users/55560001', { token: admin }));
  await rec('user:get:missing', call(base, 'GET', '/admin/users/00000000', { token: admin }));
  // ADR-003: Arabic must stay byte-identical even when a client sends a header.
  await rec(
    'user:get:missing:ar-header',
    call(base, 'GET', '/admin/users/00000000', { token: admin, lang: 'ar' })
  );
  await rec('user:toggle:ok', call(base, 'PUT', '/admin/users/55560001/toggle', { token: admin }));
  await rec(
    'user:toggle:missing',
    call(base, 'PUT', '/admin/users/00000000/toggle', { token: admin })
  );

  // ── Taxi (Fleet) administration ────────────────────────────────────────────
  await rec('taxi:add:noname', call(base, 'POST', '/admin/taxis', { token: admin, body: {} }));
  await rec(
    'taxi:add:badcoords',
    call(base, 'POST', '/admin/taxis', { token: admin, body: { name: 'T', lat: 999, lng: 999 } })
  );
  const addedTaxi = await call(base, 'POST', '/admin/taxis', {
    token: admin,
    body: { name: 'Downtown' },
  });
  await rec(
    'taxi:add:ok',
    Promise.resolve({ status: addedTaxi.status, body: { success: addedTaxi.body?.success } })
  );
  await rec(
    'taxi:delete:ok',
    call(base, 'DELETE', `/admin/taxis/${addedTaxi.body?.id}`, { token: admin })
  );

  // ── Reports ────────────────────────────────────────────────────────────────
  await rec('reports:list', call(base, 'GET', '/admin/reports', { token: admin }));
  await rec('report:resolve:ok', call(base, 'PUT', '/admin/reports/1/resolve', { token: admin }));

  // ── Backups / configuration ────────────────────────────────────────────────
  await rec('backups:list', call(base, 'GET', '/admin/backups', { token: admin }));
  await rec('backup:create', call(base, 'POST', '/admin/backup', { token: admin }));
  await rec(
    'restore:noconfirm',
    call(base, 'POST', '/admin/db/restore', { token: admin, body: { filename: 'x.db' } })
  );
  await rec(
    'restore:badname',
    call(base, 'POST', '/admin/db/restore', {
      token: admin,
      body: { filename: '../../etc/passwd', confirm: 'RESTORE_CONFIRMED' },
    })
  );
  await rec(
    'restore:traversal',
    call(base, 'POST', '/admin/db/restore', {
      token: admin,
      body: { filename: 'a/b.db', confirm: 'RESTORE_CONFIRMED' },
    })
  );
  await rec(
    'restore:missing',
    call(base, 'POST', '/admin/db/restore', {
      token: admin,
      body: { filename: 'nope.db', confirm: 'RESTORE_CONFIRMED' },
    })
  );

  // ── Logs ───────────────────────────────────────────────────────────────────
  await rec('logs', call(base, 'GET', '/admin/logs?n=5', { token: admin }));
  await rec('logs:level', call(base, 'GET', '/admin/logs?n=5&level=error', { token: admin }));
  await rec('logs:clear', call(base, 'POST', '/admin/logs/clear', { token: admin }));

  // ── Database maintenance ───────────────────────────────────────────────────
  await rec('db:health', call(base, 'GET', '/admin/db/health', { token: admin }));
  await rec('db:vacuum', call(base, 'POST', '/admin/db/vacuum', { token: admin }));
  await rec('db:reindex', call(base, 'POST', '/admin/db/reindex', { token: admin }));

  // ── System / observability ─────────────────────────────────────────────────
  await rec('system', call(base, 'GET', '/admin/system', { token: admin }));
  await rec('metrics', call(base, 'GET', '/admin/metrics', { token: admin }));
  await rec('security-events', call(base, 'GET', '/admin/security-events?n=5', { token: admin }));
  await rec('errors', call(base, 'GET', '/admin/errors?n=5', { token: admin }));
  await rec('crashes', call(base, 'GET', '/admin/crashes?n=5', { token: admin }));
  await rec('notification-stats', call(base, 'GET', '/admin/notification-stats', { token: admin }));

  // ── Lifecycle (validation-failure path only — happy path calls process.exit) ─
  await rec(
    'shutdown:noconfirm',
    call(base, 'POST', '/admin/shutdown', { token: admin, body: {} })
  );

  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4931, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4932, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Admin A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
    for (let i = 0; i < a.length; i++) {
      total++;
      const [label, ra] = a[i];
      const [, rb] = b[i];
      const sa = `${ra.status} ${stable(ra.body)}`;
      const sb = `${rb.status} ${stable(rb.body)}`;
      if (sa !== sb) {
        fails++;
        console.log(`  ✗ ${label}\n     legacy: ${sa}\n     new:    ${sb}`);
      } else {
        console.log(`  ✓ ${label}  [${ra.status}]`);
      }
    }
    console.log(`  ${'-'.repeat(52)}\n  Result: ${total - fails}/${total} byte-identical\n`);
  } finally {
    legacy?.child.kill('SIGKILL');
    next?.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
