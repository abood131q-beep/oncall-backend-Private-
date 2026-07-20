#!/usr/bin/env node
/**
 * Scooters cutover A/B compatibility proof (Migration Phase 5).
 *
 * Boots the REAL server twice — legacy router (SCOOTERS_LEGACY=1) and the new
 * enterprise router — on fresh databases, drives an identical scenario suite
 * through both, normalizes nondeterministic fields (tokens, ids, datetimes,
 * ride timing), and diffs every (status, body) pair ORDER-SENSITIVELY (JSON key
 * order included). Any difference fails.
 *
 * Run: node tests/integration/scooters-ab.mjs
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

// Ride timing/fare/battery/balance are wall-clock dependent → normalized.
const VOLATILE_KEYS =
  /^(id|scooter_code|rideId|startTime|ride_start_time|durationMinutes|currentFare|duration|fare|newBalance|newBattery|battery|created_at|end_time|start_time|balance)$/;

function normalize(value, key = '') {
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
  if (VOLATILE_KEYS.test(key)) return '<V>';
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
        SCOOTERS_LEGACY: legacy ? '1' : '0',
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

async function call(base, method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function tokenFor(base, phone, name) {
  return (await call(base, 'POST', '/login', { body: { phone, name } })).body.token;
}

async function runScenarios(base) {
  const out = [];
  const rec = async (label, p) => out.push([label, await p]);

  const admin = await tokenFor(base, ADMIN_PHONE, 'Admin');
  const rider = await tokenFor(base, '55577701', 'Rider'); // balance 0 by default
  const other = await tokenFor(base, '55577702', 'Other');

  // Public discovery
  await rec('list', call(base, 'GET', '/scooters'));
  await rec('details:known', call(base, 'GET', '/scooters/1'));
  await rec('details:missing', call(base, 'GET', '/scooters/99999'));
  // Admin add (invalid + valid)
  await rec(
    'admin:add:badcoords',
    call(base, 'POST', '/admin/scooters', {
      token: admin,
      body: { name: 'S9', scooter_code: 'SC9', lat: 999, lng: 999, battery: 80 },
    })
  );
  await rec(
    'admin:add:ok',
    call(base, 'POST', '/admin/scooters', {
      token: admin,
      body: { name: 'S9', scooter_code: 'SC9', lat: 29.37, lng: 47.98, battery: 80 },
    })
  );
  await rec('admin:add:noauth', call(base, 'POST', '/admin/scooters', { body: { name: 'x' } }));
  // Unlock gates
  await rec(
    'unlock:missing',
    call(base, 'POST', '/scooter/unlock', { token: rider, body: { scooterId: 99999 } })
  );
  await rec('unlock:noauth', call(base, 'POST', '/scooter/unlock', { body: { scooterId: 1 } }));
  await rec(
    'unlock:lowbalance',
    call(base, 'POST', '/scooter/unlock', { token: rider, body: { scooterId: 1 } })
  );
  // Happy path with the seeded demo user (balance 10): unlock → active → end-ride
  const demo = await tokenFor(base, '99999999', 'Demo');
  await rec(
    'unlock:ok',
    call(base, 'POST', '/scooter/unlock', { token: demo, body: { scooterId: 1 } })
  );
  await rec('active:riding', call(base, 'GET', '/scooter/active/99999999', { token: demo }));
  await rec(
    'endride:ok',
    call(base, 'POST', '/scooter/end-ride', {
      token: demo,
      body: { scooterId: 1, endLat: 29.38, endLng: 47.99 },
    })
  );
  await rec('active:after', call(base, 'GET', '/scooter/active/99999999', { token: demo }));
  await rec('history:after', call(base, 'GET', '/scooter/history/99999999', { token: demo }));
  // Deprecated
  await rec('rent:410', call(base, 'POST', '/scooter/rent', { token: rider, body: {} }));
  await rec('return:410', call(base, 'POST', '/scooter/return', { token: rider, body: {} }));
  // Active / history (no active ride)
  await rec('active:none', call(base, 'GET', '/scooter/active/55577701', { token: rider }));
  await rec('history:empty', call(base, 'GET', '/scooter/history/55577701', { token: rider }));
  await rec('active:noauth', call(base, 'GET', '/scooter/active/55577701', {}));
  // End-ride with no active ride (not your scooter)
  await rec(
    'endride:notyours',
    call(base, 'POST', '/scooter/end-ride', { token: other, body: { scooterId: 1 } })
  );
  await rec(
    'endride:missing',
    call(base, 'POST', '/scooter/end-ride', { token: rider, body: { scooterId: 99999 } })
  );
  // Admin delete + reset
  await rec('admin:delete', call(base, 'DELETE', '/admin/scooters/2', { token: admin }));
  await rec('reset:noauth', call(base, 'POST', '/scooters/reset', {}));
  await rec('reset:ok', call(base, 'POST', '/scooters/reset', { token: admin }));
  return out;
}

const stable = (v) => JSON.stringify(normalize(v));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'scooters-ab-'));
  let legacy,
    next,
    fails = 0,
    total = 0;
  try {
    legacy = await startServer({ legacy: true, port: 4901, dbPath: join(dir, 'legacy.db') });
    next = await startServer({ legacy: false, port: 4902, dbPath: join(dir, 'new.db') });
    const a = await runScenarios(legacy.base);
    const b = await runScenarios(next.base);
    console.log(`\n  Scooters A/B compatibility — ${a.length} scenarios\n  ${'-'.repeat(52)}`);
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
