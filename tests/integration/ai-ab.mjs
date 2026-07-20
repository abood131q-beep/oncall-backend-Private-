#!/usr/bin/env node
/**
 * AI / Automation cutover A/B compatibility proof (Migration Phase 10).
 *
 * The AI/Automation context is an OWNERSHIP-establishment migration: it adds no
 * HTTP endpoint and calls no inference provider (none is configured — ADR-011
 * §8). The invariant to prove is therefore ZERO DRIFT: the platform must behave
 * byte-identically whether the AI context is registered (default) or not
 * (AI_LEGACY=1). This harness boots the REAL server twice on fresh databases and
 * drives a representative cross-section of the EXISTING public surface (health,
 * identity, fleet, trips, admin auth/RBAC, notifications, localization) through
 * both arms, diffing every (status, body) pair ORDER-SENSITIVELY.
 *
 * Run: node tests/integration/ai-ab.mjs
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
const VOLATILE_KEYS =
  /^(id|token|refreshToken|created_at|updated_at|expires_at|expiresAt|lat|lng|uptime|timestamp|pid)$/;

function normalize(value, key = '') {
  if (VOLATILE_KEYS.test(key)) return '<V>';
  if (Array.isArray(value)) {
    const arr = value.map((v) => normalize(v));
    // Directory listings (userRepo.findAll → `ORDER BY created_at DESC`) tie on a
    // same-second created_at; SQLite's tie-break order is nondeterministic and NOT
    // part of the contract. Sort phone-keyed rows to compare membership, not order.
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

async function startServer({ aiLegacy, port, dbPath }) {
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
        AI_LEGACY: aiLegacy ? '1' : '0',
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
  throw new Error(`server failed (aiLegacy=${aiLegacy})\n${logs.slice(-1500)}`);
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

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = (await login(base, ADMIN_PHONE, 'Admin')).token;
  const passenger = (await login(base, '55580001', 'Alice')).token;

  // Health / platform
  await rec('health', call(base, 'GET', '/health'));
  // Identity
  await rec('login:ok', call(base, 'POST', '/login', { body: { phone: '55580002', name: 'Bob' } }));
  await rec('login:badphone', call(base, 'POST', '/login', { body: { phone: '1' } }));
  await rec('404', call(base, 'GET', '/definitely-not-a-route'));
  // Fleet (Phase 9)
  await rec('taxis', call(base, 'GET', '/taxis'));
  await rec('taxi:add:noname', call(base, 'POST', '/admin/taxis', { token: admin, body: {} }));
  await rec(
    'taxi:add:ok',
    call(base, 'POST', '/admin/taxis', { token: admin, body: { name: 'T' } })
  );
  // Trips
  await rec('trips:requests', call(base, 'GET', '/taxi/requests', { token: admin }));
  await rec(
    'trip:create',
    call(base, 'POST', '/taxi/request', {
      token: passenger,
      body: { pickup: 'Salmiya', destination: 'Kuwait City', payment_method: 'cash' },
    })
  );
  // Admin (auth + a real read)
  await rec('admin:stats:noauth', call(base, 'GET', '/admin/stats'));
  await rec('admin:stats:passenger', call(base, 'GET', '/admin/stats', { token: passenger }));
  await rec('admin:users', call(base, 'GET', '/admin/users', { token: admin }));
  await rec('admin:revenue', call(base, 'GET', '/admin/revenue', { token: admin }));
  // Notifications
  await rec('notif:register:noauth', call(base, 'POST', '/notifications/register', { body: {} }));
  // Localization (Arabic default vs additive English)
  await rec(
    'user:missing:ar',
    call(base, 'GET', '/admin/users/00000000', { token: admin, lang: 'ar' })
  );
  await rec(
    'user:missing:en',
    call(base, 'GET', '/admin/users/00000000', { token: admin, lang: 'en' })
  );

  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-ab-'));
  let a1,
    a2,
    fails = 0,
    total = 0;
  try {
    // Arm A: AI context NOT registered (rollback). Arm B: AI context registered (default).
    a1 = await startServer({ aiLegacy: true, port: 4951, dbPath: join(dir, 'legacy.db') });
    a2 = await startServer({ aiLegacy: false, port: 4952, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(a1.base);
    const b = await runScenarios(a2.base);
    console.log(
      `\n  AI zero-drift A/B — ${a.length} scenarios (AI_LEGACY=1 vs registered)\n  ${'-'.repeat(52)}`
    );
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
    console.log(
      `  ${'-'.repeat(52)}\n  Result: ${total - fails}/${total} byte-identical (zero drift)\n`
    );
  } finally {
    a1?.child.kill('SIGKILL');
    a2?.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
