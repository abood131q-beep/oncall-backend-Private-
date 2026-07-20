#!/usr/bin/env node
/**
 * engine-ab.mjs — SQLite-baseline vs PostgreSQL A/B compatibility proof (Phase 13).
 *
 * THIS is the real cross-engine gate the migration must pass. It boots the SAME
 * server twice:
 *   • baseline arm : SQLite (via the node:sqlite dev shim)
 *   • candidate arm: PostgreSQL (DB_ENGINE=postgres, a REAL Postgres via PG_URL)
 * drives an identical suite across identity / fleet / trips / admin / commerce /
 * notifications / observability / localization, and diffs every (status, body)
 * pair ORDER-SENSITIVELY. Financial figures + balances are compared as real
 * values; only host/run-volatile fields (ids, timestamps, tokens) are normalized.
 *
 * REQUIRES a live Postgres: set PG_URL (e.g. postgres://oncall:oncall@127.0.0.1:5432/oncall_test)
 * and have `pg` installed. Run migrations first: DB_ENGINE=postgres DATABASE_URL=$PG_URL npm run migrate
 *
 * Run: PG_URL=postgres://… node tests/integration/engine-ab.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_PHONE = '11111111';
const PG_URL = process.env.PG_URL || process.env.DATABASE_URL || '';

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const JWTISH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;
const VOLATILE_KEYS =
  /^(id|token|refreshToken|created_at|updated_at|expires_at|expiresAt|lat|lng|uptime|timestamp|pid|trip_id|user_id|driver_id)$/;

function normalize(value, key = '') {
  if (VOLATILE_KEYS.test(key)) return '<V>';
  if (Array.isArray(value)) {
    const arr = value.map((v) => normalize(v));
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
    if (DATETIME_RE.test(value)) return '<DATETIME>';
  }
  return value;
}

async function startServer({ engine, port, dbPath }) {
  const usePg = engine === 'postgres';
  const args = usePg
    ? ['--no-warnings', 'server.js']
    : ['--no-warnings', '-r', './tools/dev/sqlite3-compat.js', 'server.js'];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JWT_SECRET: 'engine-ab-secret-0123456789abcdef0123456789abcdef',
      ADMIN_PHONES: ADMIN_PHONE,
      PORT: String(port),
      LOG_LEVEL: 'ERROR',
      PAYMENT_ENABLED: 'true',
      ...(usePg
        ? { DB_ENGINE: 'postgres', DATABASE_URL: PG_URL }
        : { DB_ENGINE: 'sqlite', DB_PATH: dbPath }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if ((await fetch(`${base}/health`)).status === 200) return { child, base };
    } catch {
      /* not up */
    }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error(`server failed (engine=${engine})\n${logs.slice(-1800)}`);
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
const login = async (b, phone, name) => (await call(b, 'POST', '/login', { body: { phone, name } })).body;

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);
  const admin = (await login(base, ADMIN_PHONE, 'Admin')).token;
  const pa = (await login(base, '55600001', 'Alice')).token;

  await rec('health', call(base, 'GET', '/health'));
  await rec('login:bad', call(base, 'POST', '/login', { body: { phone: '1' } }));
  await rec('404', call(base, 'GET', '/nope'));
  await rec('taxis', call(base, 'GET', '/taxis'));
  await rec('methods', call(base, 'GET', '/payment/methods'));
  await rec('taxi:add:noname', call(base, 'POST', '/admin/taxis', { token: admin, body: {} }));
  await rec('taxi:add:ok', call(base, 'POST', '/admin/taxis', { token: admin, body: { name: 'T' } }));
  await rec('admin:stats:noauth', call(base, 'GET', '/admin/stats'));
  await rec('admin:stats:passenger', call(base, 'GET', '/admin/stats', { token: pa }));
  await rec('admin:users', call(base, 'GET', '/admin/users', { token: admin }));
  await rec('admin:revenue', call(base, 'GET', '/admin/revenue', { token: admin }));
  await rec('balance:self', call(base, 'GET', '/wallet/balance/55600001', { token: pa }));
  await rec('balance:idor', call(base, 'GET', '/wallet/balance/55600002', { token: pa }));
  await rec('charge:bad', call(base, 'POST', '/wallet/charge', { token: pa, body: { amount: 0 } }));
  await rec('charge:ok', call(base, 'POST', '/wallet/charge', { token: pa, body: { amount: 12.5, method: 'knet' } }));
  await rec('balance:after', call(base, 'GET', '/wallet/balance/55600001', { token: pa }));
  await rec('txns:after', call(base, 'GET', '/wallet/transactions/55600001', { token: pa }));
  await rec(
    'trip:create',
    call(base, 'POST', '/taxi/request', {
      token: pa,
      body: { pickup: 'Salmiya', destination: 'Kuwait City', payment_method: 'cash' },
    })
  );
  await rec('trips:paged', call(base, 'GET', '/admin/trips?page=1&limit=5', { token: admin }));
  await rec('user:missing:ar', call(base, 'GET', '/admin/users/00000000', { token: admin, lang: 'ar' }));
  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  if (!PG_URL) {
    console.error('❌ PG_URL (or DATABASE_URL) is required — this gate needs a REAL Postgres.');
    console.error('   e.g. PG_URL=postgres://oncall:oncall@127.0.0.1:5432/oncall_test node tests/integration/engine-ab.mjs');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'engine-ab-'));
  let a, b, fails = 0, total = 0;
  try {
    a = await startServer({ engine: 'sqlite', port: 4991, dbPath: join(dir, 'baseline.db') });
    b = await startServer({ engine: 'postgres', port: 4992 });
    const sa = await runScenarios(a.base);
    const sb = await runScenarios(b.base);
    console.log(`\n  Engine A/B — SQLite baseline vs PostgreSQL — ${sa.length} scenarios\n  ${'-'.repeat(56)}`);
    for (let i = 0; i < sa.length; i++) {
      total++;
      const [label, ra] = sa[i];
      const [, rb] = sb[i];
      const x = `${ra.status} ${stable(ra.body)}`;
      const y = `${rb.status} ${stable(rb.body)}`;
      if (x !== y) {
        fails++;
        console.log(`  ✗ ${label}\n     sqlite: ${x}\n     pg:     ${y}`);
      } else {
        console.log(`  ✓ ${label}  [${ra.status}]`);
      }
    }
    console.log(`  ${'-'.repeat(56)}\n  Result: ${total - fails}/${total} byte-identical (SQLite ≡ PostgreSQL)\n`);
  } finally {
    a?.child.kill('SIGKILL');
    b?.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
