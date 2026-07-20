#!/usr/bin/env node
/**
 * Fleet cutover A/B compatibility proof (Migration Phase 9).
 *
 * Boots the REAL server twice — legacy co-located handlers (FLEET_LEGACY=1, the
 * `GET /taxis` handler in Trips + the `POST/DELETE /admin/taxis` handlers in
 * Admin) and the new enterprise Fleet router — on fresh databases, drives an
 * identical suite through both (list, register with validation, remove, auth &
 * RBAC negatives, localization), normalizes nondeterministic fields, and diffs
 * every (status, body) pair ORDER-SENSITIVELY.
 *
 * Run: node tests/integration/fleet-ab.mjs
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
// The `taxis` row id is an autoincrement PK → host/run dependent → normalized.
const VOLATILE_KEYS = /^(id|lat|lng)$/;

function normalize(value, key = '') {
  if (VOLATILE_KEYS.test(key)) return '<V>';
  if (Array.isArray(value)) return value.map((v) => normalize(v));
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
        FLEET_LEGACY: legacy ? '1' : '0',
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

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = (await login(base, ADMIN_PHONE, 'Admin')).token;
  const passenger = (await login(base, '55570001', 'Alice')).token;

  // ── Public lookup (empty) ──────────────────────────────────────────────────
  await rec('taxis:empty', call(base, 'GET', '/taxis'));

  // ── Register — auth gate + validation ──────────────────────────────────────
  await rec('add:noauth', call(base, 'POST', '/admin/taxis', { body: { name: 'X' } }));
  await rec(
    'add:passenger',
    call(base, 'POST', '/admin/taxis', { token: passenger, body: { name: 'X' } })
  );
  await rec('add:noname', call(base, 'POST', '/admin/taxis', { token: admin, body: {} }));
  await rec(
    'add:blankname',
    call(base, 'POST', '/admin/taxis', { token: admin, body: { name: '   ' } })
  );
  await rec(
    'add:noname:en',
    call(base, 'POST', '/admin/taxis', { token: admin, body: {}, lang: 'en' })
  );
  await rec(
    'add:badcoords',
    call(base, 'POST', '/admin/taxis', { token: admin, body: { name: 'T', lat: 999, lng: 999 } })
  );
  await rec(
    'add:badcoords:en',
    call(base, 'POST', '/admin/taxis', {
      token: admin,
      body: { name: 'T', lat: 999, lng: 999 },
      lang: 'en',
    })
  );

  // ── Register — success (default coords + explicit coords) ──────────────────
  const addedDefault = await call(base, 'POST', '/admin/taxis', {
    token: admin,
    body: { name: 'Downtown' },
  });
  await rec('add:ok:default', Promise.resolve(addedDefault));
  const addedExplicit = await call(base, 'POST', '/admin/taxis', {
    token: admin,
    body: { name: 'Salmiya', lat: 29.34, lng: 48.05 },
  });
  await rec('add:ok:explicit', Promise.resolve(addedExplicit));

  // Fresh servers → deterministic ids; strip the cache by using two fresh boots.
  // Remove one (unconditional delete → success even for a missing id).
  await rec('delete:noauth', call(base, 'DELETE', '/admin/taxis/1'));
  await rec('delete:passenger', call(base, 'DELETE', '/admin/taxis/1', { token: passenger }));
  await rec('delete:missing', call(base, 'DELETE', '/admin/taxis/999999', { token: admin }));
  await rec(
    'delete:ok',
    call(base, 'DELETE', `/admin/taxis/${addedExplicit.body?.id}`, { token: admin })
  );

  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4941, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4942, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Fleet A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
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
